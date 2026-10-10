/**
 * Pins `./GitCafeSourceControlProvider.ts`, which pass 2 creates:
 *
 * - `discovery: SourceControlCliDiscoverySpec` — kind `"gitcafe"`, executable `"cafe"`,
 *   `authArgs` ending in `["auth", "status", "--json"]` against `https://git.cafe/api`, and a
 *   `parseAuth` that reads cafe's `{ schemaVersion: 1, data: { host, username } }` answer and its
 *   `{ schemaVersion: 1, error: { code, status, message } }` failure envelope.
 * - `make: Effect<SourceControlProvider["Service"], never, GitCafeApi | SourceControlHost>` with
 *   kind `"gitcafe"`, resolving the repository and host from the checkout's remote.
 *
 * Uses `./GitCafeApi.ts` and `./GitCafeCredentials.ts` as pinned in the sibling tests.
 */
import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeSourceControlProvider from "./GitCafeSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const authAnswer = (input: { stdout?: unknown; stderr?: unknown; exitCode?: number }) => ({
  stdout: input.stdout === undefined ? "" : encodeJson(input.stdout),
  stderr: input.stderr === undefined ? "" : encodeJson(input.stderr),
  exitCode: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
});
const failure = (code: string, status: number | null) => ({
  schemaVersion: 1,
  error: { code, status, message: `Failure ${code}` },
});

describe("GitCafeSourceControlProvider", () => {
  it("probes the cafe CLI against production", () => {
    const { discovery } = GitCafeSourceControlProvider;
    assert.strictEqual(discovery.kind, "gitcafe");
    assert.strictEqual(discovery.executable, "cafe");
    assert.deepStrictEqual(discovery.authArgs.slice(0, 2), ["--host", "https://git.cafe/api"]);
    assert.deepStrictEqual(discovery.authArgs.slice(-3), ["auth", "status", "--json"]);
  });

  it("reads a signed-in account and keeps transient failures apart from sign-out", () => {
    const { parseAuth } = GitCafeSourceControlProvider.discovery;
    const signedIn = parseAuth(
      authAnswer({ stdout: { schemaVersion: 1, data: { host: "git.cafe", username: "alice" } } }),
    );
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("alice"));
    assert.strictEqual(
      parseAuth(authAnswer({ stderr: failure("AUTHENTICATION_REQUIRED", 401), exitCode: 1 }))
        .status,
      "unauthenticated",
    );
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NETWORK_ERROR", null],
    ] as const) {
      assert.strictEqual(
        parseAuth(authAnswer({ stderr: failure(code, status), exitCode: 1 })).status,
        "unknown",
      );
    }
  });

  it.effect.each([
    ["https://staging.git.cafe/team/project.git", "staging.git.cafe"],
    ["ssh@git.cafe:team/project.git", "git.cafe"],
  ] as const)("resolves the repository from the remote %s", ([remoteUrl, host]) => {
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson({ name: "project", defaultBranch: "trunk" })),
        ),
      );
    });
    const context = {
      provider: { kind: "gitcafe" as const, name: "GitCafe", baseUrl: `https://${host}` },
      remoteName: "origin",
      remoteUrl,
    };
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      assert.strictEqual(provider.kind, "gitcafe");
      assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo", context }), "trunk");
      assert.deepStrictEqual(
        yield* provider.getRepositoryCloneUrls({ cwd: "/repo", context, repository: remoteUrl }),
        {
          nameWithOwner: "team/project",
          url: `https://${host}/team/project`,
          sshUrl: `ssh@${host}:team/project.git`,
        },
      );
      assert.deepStrictEqual(urls, [
        `https://${host}/api/repos/team/project`,
        `https://${host}/api/repos/team/project`,
      ]);
    }).pipe(
      Effect.provide(
        GitCafeApi.layer.pipe(
          Layer.provide(GitCafeCredentials.layer),
          Layer.provideMerge(TestSourceControlHost.layer()),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token", CAFE_HOST: host }),
          ),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });

  it.effect(
    "reads a bare owner/name on git.cafe without a remote, and no other host's pulls",
    () => {
      const urls: Array<string> = [];
      const client = HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson({ name: "project", defaultBranch: "trunk" })),
          ),
        );
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafeSourceControlProvider.make;
        // The checkout has no remote at all, as when a repository is about to be created.
        assert.deepStrictEqual(
          yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository: "team/project" }),
          {
            nameWithOwner: "team/project",
            url: "https://git.cafe/team/project",
            sshUrl: "ssh@git.cafe:team/project.git",
          },
        );
        const foreign = yield* provider
          .getChangeRequest({
            cwd: "/repo",
            reference: "https://example.com/team/project/pulls/42",
          })
          .pipe(Effect.flip);
        assert.strictEqual(foreign._tag, "SourceControlProviderError");
        assert.deepStrictEqual(urls, ["https://git.cafe/api/repos/team/project"]);
      }).pipe(
        Effect.provide(
          GitCafeApi.layer.pipe(
            Layer.provide(GitCafeCredentials.layer),
            Layer.provideMerge(
              TestSourceControlHost.layer({
                git: {
                  resolvePrimaryRemoteName: () =>
                    Effect.fail(
                      new GitCommandError({
                        operation: "resolvePrimaryRemoteName",
                        command: "git remote",
                        cwd: "/repo",
                        detail: "No git remote is configured.",
                      }),
                    ),
                },
              }),
            ),
            Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
            Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );
    },
  );

  it.effect.each([
    ["no context", undefined, "https://git.cafe/fork/project.git"],
    ["an HTTPS remote", "https://git.cafe/team/project.git", "https://git.cafe/fork/project.git"],
    ["an SSH remote", "ssh@git.cafe:team/project.git", "ssh@git.cafe:fork/project.git"],
    ["an ssh:// remote", "ssh://ssh@git.cafe/team/project.git", "ssh@git.cafe:fork/project.git"],
    [
      "an HTTPS remote with a user",
      "https://alice@git.cafe/team/project.git",
      "https://git.cafe/fork/project.git",
    ],
  ] as const)("checks a fork out over the transport of %s", ([, remoteUrl, expected]) => {
    const remotes: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson({
              number: 7,
              title: "Change",
              state: "open",
              draft: false,
              sourceBranch: "feature",
              targetBranch: "main",
              headOid: null,
              updatedAt: null,
              sourceRepo: { owner: "fork", name: "project" },
              closedAt: null,
              mergedAt: null,
            }),
          ),
        ),
      ),
    );
    const context =
      remoteUrl === undefined
        ? undefined
        : {
            provider: { kind: "gitcafe" as const, name: "GitCafe", baseUrl: "https://git.cafe" },
            remoteName: "origin",
            remoteUrl,
          };
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      yield* provider.checkoutChangeRequest({
        cwd: "/repo",
        reference: "https://git.cafe/team/project/pulls/7",
        ...(context === undefined ? {} : { context }),
      });
      assert.deepStrictEqual(remotes, [expected]);
    }).pipe(
      Effect.provide(
        GitCafeApi.layer.pipe(
          Layer.provide(GitCafeCredentials.layer),
          Layer.provideMerge(
            TestSourceControlHost.layer({
              git: {
                ensureRemote: (input) => {
                  remotes.push(input.url);
                  return Effect.succeed("gitcafe");
                },
                listLocalBranchNames: () => Effect.succeed([]),
                fetchRemoteBranch: () => Effect.void,
                setBranchUpstream: () => Effect.void,
                switchRef: () => Effect.succeed({ refName: null }),
              },
            }),
          ),
          Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "no selector", selection: {}, limit: 3, expected: [1, 2, 3] },
    {
      name: "an owner-qualified selector",
      selection: { headSelector: "fork:feature" },
      limit: 1,
      expected: [3],
    },
    {
      name: "an explicit source without a head selector",
      selection: { source: { refName: "feature", owner: "fork", repository: "fork/project" } },
      limit: 1,
      expected: [3],
    },
  ])(
    "lists pulls with $name while preserving pagination and limits",
    ({ selection, limit, expected }) => {
      const urls: Array<URL> = [];
      const pull = (number: number) => ({
        number,
        title: `Change ${number}`,
        state: "open",
        draft: false,
        sourceBranch: number === 1 ? "other" : "feature",
        targetBranch: "main",
        updatedAt: null,
      });
      const client = HttpClient.make((request) => {
        const url = new URL(request.url);
        urls.push(url);
        const detailNumber = /\/pulls\/(\d+)$/u.exec(url.pathname)?.[1];
        const number = Number(detailNumber);
        const body = detailNumber
          ? {
              ...pull(number),
              sourceRepo: { owner: number === 2 ? "other" : "fork", name: "project" },
              closedAt: null,
              mergedAt: null,
            }
          : url.searchParams.has("after")
            ? { items: [pull(3), pull(4)], next: null }
            : { items: [pull(1), pull(2)], next: "page-2" };
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(encodeJson(body))));
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafeSourceControlProvider.make;
        const pulls = yield* provider.listChangeRequests({
          cwd: "/repo",
          context: {
            provider: { kind: "gitcafe", name: "GitCafe", baseUrl: "https://git.cafe" },
            remoteName: "origin",
            remoteUrl: "https://git.cafe/team/project.git",
          },
          state: "open",
          ...selection,
          limit,
        });
        assert.deepStrictEqual(
          pulls.map((item) => item.number),
          expected,
        );
        const pages = urls.filter((url) => url.pathname.endsWith("/pulls"));
        assert.strictEqual(pages.length, 2);
        assert.strictEqual(pages[0]?.searchParams.get("after"), null);
        assert.strictEqual(pages[1]?.searchParams.get("after"), "page-2");
        for (const page of pages) {
          assert.strictEqual(page.pathname, "/api/repos/team/project/pulls");
          assert.strictEqual(page.searchParams.get("state"), "open");
          assert.strictEqual(page.searchParams.get("limit"), String(limit));
          assert.strictEqual(
            page.searchParams.get("sourceBranches"),
            expected.length === 3 ? null : '["feature"]',
          );
        }
        assert.deepStrictEqual(
          urls
            .filter((url) => /\/pulls\/\d+$/u.test(url.pathname))
            .map((url) => Number(url.pathname.split("/").at(-1))),
          expected.length === 3 ? [1, 2, 3] : [2, 3],
        );
      }).pipe(
        Effect.provide(
          GitCafeApi.layer.pipe(
            Layer.provide(GitCafeCredentials.layer),
            Layer.provideMerge(TestSourceControlHost.layer()),
            Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
            Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );
    },
  );

  it.effect("waits for a created repository's admission before handing out its URLs", () => {
    const urls: Array<string> = [];
    const states = ["running", "complete"];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson({
              repoId: "repo_1",
              state: states.shift(),
              owner: "team",
              name: "project",
            }),
          ),
        ),
      );
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      const created = yield* provider
        .createRepository({ cwd: "/repo", repository: "team/project", visibility: "private" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(created), {
        nameWithOwner: "team/project",
        url: "https://git.cafe/team/project",
        sshUrl: "ssh@git.cafe:team/project.git",
      });
      assert.deepStrictEqual(urls, [
        "https://git.cafe/api/orgs/team/admissions/repo_1",
        "https://git.cafe/api/orgs/team/admissions/repo_1",
      ]);
    }).pipe(
      Effect.provide(
        GitCafeApi.layer.pipe(
          Layer.provide(GitCafeCredentials.layer),
          Layer.provideMerge(
            TestSourceControlHost.layer({
              process: {
                run: () =>
                  Effect.succeed(
                    TestSourceControlHost.processOutput(
                      encodeJson({
                        schemaVersion: 1,
                        data: {
                          resource: {
                            repoId: "repo_1",
                            state: "running",
                            owner: "team",
                            name: "project",
                          },
                        },
                      }),
                    ),
                  ),
              },
              git: {
                resolvePrimaryRemoteName: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: "resolvePrimaryRemoteName",
                      command: "git remote",
                      cwd: "/repo",
                      detail: "No git remote is configured.",
                    }),
                  ),
              },
            }),
          ),
          Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });
});

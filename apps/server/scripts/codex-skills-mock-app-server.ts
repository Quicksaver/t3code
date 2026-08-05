#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

const cwdLogPath = process.env.T3_CODEX_CWD_LOG_PATH;
const argsLogPath = process.env.T3_CODEX_ARGS_LOG_PATH;
const exitLogPath = process.env.T3_CODEX_EXIT_LOG_PATH;
const hangSkillsList = process.env.T3_CODEX_HANG_SKILLS_LIST === "1";
const unauthenticated = process.env.T3_CODEX_UNAUTHENTICATED === "1";
const failPluginInstalled = process.env.T3_CODEX_FAIL_PLUGIN_INSTALLED === "1";

function appendLog(path: string | undefined, line: string): void {
  if (path) NodeFS.appendFileSync(path, `${line}\n`, "utf8");
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function respondError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
}

process.once("SIGTERM", () => {
  appendLog(exitLogPath, "SIGTERM");
  process.exit(0);
});
process.once("exit", (code) => appendLog(exitLogPath, `exit:${code}`));

let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message.id;
    if ((typeof id !== "number" && typeof id !== "string") || typeof message.method !== "string") {
      continue;
    }

    switch (message.method) {
      case "initialize":
        appendLog(cwdLogPath, process.cwd());
        appendLog(argsLogPath, JSON.stringify(process.argv.slice(2)));
        respond(id, {
          userAgent: "t3code-codex-skills-test",
          codexHome: process.cwd(),
          platformFamily: "unix",
          platformOs: "linux",
        });
        break;
      case "account/read":
        respond(
          id,
          unauthenticated
            ? {
                account: null,
                requiresOpenaiAuth: true,
              }
            : {
                account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
                requiresOpenaiAuth: false,
              },
        );
        break;
      case "skills/list":
        if (!hangSkillsList) {
          respond(id, {
            data: [
              {
                cwd: process.cwd(),
                errors: [],
                skills: [
                  {
                    name: "workspace-skill",
                    description: "A workspace-scoped test skill.",
                    shortDescription: "Workspace test skill",
                    path: `${process.cwd()}/.agents/skills/workspace-skill/SKILL.md`,
                    scope: "repo",
                    enabled: true,
                  },
                ],
              },
            ],
          });
        }
        break;
      case "plugin/installed":
        if (failPluginInstalled) {
          respondError(id, -32601, "plugin/installed unavailable");
          break;
        }
        respond(id, {
          marketplaces: [
            {
              name: "openai-curated-remote",
              path: null,
              plugins: [
                {
                  authPolicy: "ON_USE",
                  availability: "AVAILABLE",
                  enabled: true,
                  id: "coderabbit@openai-curated-remote",
                  installPolicy: "AVAILABLE",
                  installed: true,
                  name: "coderabbit",
                  remotePluginId: "remote-coderabbit-id",
                  source: { type: "remote" },
                  version: "1.1.4",
                },
              ],
            },
          ],
        });
        break;
      case "plugin/read": {
        const params = message.params as Record<string, unknown> | undefined;
        if (
          params?.pluginName !== "remote-coderabbit-id" ||
          params.remoteMarketplaceName !== "openai-curated-remote"
        ) {
          respondError(id, -32602, "unexpected remote plugin read target");
          break;
        }
        respond(id, {
          plugin: {
            appTemplates: [],
            apps: [],
            description: "CodeRabbit review plugin.",
            hooks: [],
            marketplaceName: "openai-curated-remote",
            marketplacePath: null,
            mcpServers: [],
            scheduledTasks: [],
            shareUrl: null,
            skills: [
              {
                description: "Reviews code changes using CodeRabbit AI.",
                enabled: true,
                interface: {
                  displayName: "CodeRabbit Review",
                  shortDescription: "Run CodeRabbit against the current changes",
                },
                name: "code-review",
                path: null,
                shortDescription: "Run CodeRabbit against the current changes",
              },
            ],
            summary: {
              authPolicy: "ON_USE",
              availability: "AVAILABLE",
              enabled: true,
              id: "coderabbit@openai-curated-remote",
              installPolicy: "AVAILABLE",
              installed: true,
              name: "coderabbit",
              remotePluginId: "remote-coderabbit-id",
              source: { type: "remote" },
              version: "1.1.4",
            },
          },
        });
        break;
      }
      default:
        respond(id, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));

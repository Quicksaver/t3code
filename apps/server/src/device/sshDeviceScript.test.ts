// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  quoteRemoteArg,
  remoteDeviceEnvironment,
  remoteDeviceNodeEnvironment,
  remoteDeviceScript,
} from "./sshDeviceScript.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it("runs Windows npm probe and installation through Node with paths containing spaces", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 npm fixture "));
  try {
    const node = NodePath.join(home, "Node runtime", "node.exe");
    const npm = NodePath.join(NodePath.dirname(node), "node_modules/npm/bin/npm-cli.js");
    const calls = NodePath.join(home, "npm calls.jsonl");
    await NodeFSP.mkdir(NodePath.dirname(npm), { recursive: true });
    await NodeFSP.copyFile(process.execPath, node);
    await NodeFSP.writeFile(
      npm,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ node: process.execPath, args }) + '\\n');
if (args[0] === 'install') { console.error('fixture registry unavailable'); process.exitCode = 23; }
else console.log('11.0.0');`,
    );
    const invoke = async (mode: "probe" | "start", npmPath = "", nodeVersion?: string) => {
      const script = NodePath.join(home, `${mode}.cjs`);
      await NodeFSP.writeFile(
        script,
        `Object.defineProperty(process, 'platform', { value: 'win32' });
${nodeVersion ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });` : ""}
require('node:os').homedir = () => ${JSON.stringify(home)};
const childProcess = require('node:child_process');
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => command === 'adb'
  ? { status: 0, stdout: '', stderr: '' }
  : originalSpawnSync(command, args, options);
` + remoteDeviceScript("fixture", mode),
      );
      return exec(node, [script], { env: { ...process.env, PATH: npmPath } });
    };
    expect(JSON.parse((await invoke("probe")).stdout).nodePath).toBe(node);
    await expect(invoke("start")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Installing expo-device-hub: exit code 23: fixture registry unavailable",
      ),
    });
    const invocations = (await NodeFSP.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations).toEqual([
      { node, args: ["--version"] },
      {
        node,
        args: [
          "install",
          "--prefix",
          expect.stringContaining(home),
          "--no-fund",
          "--no-audit",
          `expo-device-hub@${DEVICE_HUB_VERSION}`,
        ],
      },
    ]);
    await NodeFSP.writeFile(
      npm,
      "console.error('fixture npm configuration invalid'); process.exitCode = 17;",
    );
    await expect(invoke("probe")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "npm probe failed: exit code 17: fixture npm configuration invalid",
      ),
    });
    await NodeFSP.writeFile(
      npm,
      "console.log('fixture stdout-only failure'); process.exitCode = 19;",
    );
    for (const mode of ["probe", "start"] as const) {
      await expect(invoke(mode)).rejects.toMatchObject({
        stderr: expect.stringContaining("exit code 19: fixture stdout-only failure"),
      });
    }
    await expect(invoke("probe", "", "18.0.0")).rejects.toMatchObject({
      stderr: expect.stringContaining(`Found 18.0.0 at ${node}.`),
    });
    await NodeFSP.rm(npm);
    await expect(invoke("probe")).rejects.toMatchObject({
      stderr: expect.stringContaining("npm is missing:"),
    });
    const fallback = NodePath.join(home, "npm on PATH");
    const fallbackEntry = NodePath.join(fallback, "node_modules/npm/bin/npm-cli.js");
    await NodeFSP.mkdir(NodePath.dirname(fallbackEntry), { recursive: true });
    await NodeFSP.writeFile(fallbackEntry, "console.log('11.0.0');");
    expect(JSON.parse((await invoke("probe", `"${fallback}"`)).stdout).nodePath).toBe(node);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

for (const supported of [true, false]) {
  it.effect(
    `preserves a working SSH Node/npm pair and replaces an old Node: supported=${supported}`,
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        yield* Effect.promise(async () => {
          const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-path-"));
          try {
            const bin = NodePath.join(home, "selected-node/bin");
            const fallback = NodePath.join(home, ".local/bin");
            await NodeFSP.mkdir(bin, { recursive: true });
            await NodeFSP.mkdir(fallback, { recursive: true });
            for (const tool of ["node", "npm"]) {
              await NodeFSP.writeFile(
                NodePath.join(bin, tool),
                `#!/bin/sh\nif [ "$1" = "-e" ]; then exit ${supported ? 0 : 1}; fi\necho selected\n`,
                {
                  mode: 0o755,
                },
              );
              await NodeFSP.writeFile(
                NodePath.join(fallback, tool),
                '#!/bin/sh\nif [ "$1" = "-e" ]; then exit 0; fi\necho fallback\n',
                {
                  mode: 0o755,
                },
              );
            }
            const result = await exec(
              "/bin/sh",
              ["-c", `${remoteDeviceEnvironment}${remoteDeviceNodeEnvironment}\nnode; npm`],
              {
                env: { HOME: home, PATH: bin, JAVA_HOME: "", ANDROID_HOME: "" },
              },
            );
            expect(result.stdout).toBe(supported ? "selected\nselected\n" : "fallback\nfallback\n");
          } finally {
            await NodeFSP.rm(home, { recursive: true, force: true });
          }
        });
      }),
  );
}

it.effect("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-java-"));
      try {
        const javaHome = NodePath.join(home, ".local/opt/android-studio/jbr");
        await NodeFSP.mkdir(NodePath.join(javaHome, "bin"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(javaHome, "bin/java"),
          "#!/bin/sh\necho test-java\n",
          { mode: 0o755 },
        );
        const result = await exec("/bin/sh", ["-c", `${remoteDeviceEnvironment}\njava`], {
          env: { HOME: home, PATH: "/nonexistent", JAVA_HOME: "" },
        });
        expect(result.stdout.trim()).toBe("test-java");
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("preserves shell metacharacters and newlines in remote arguments", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    yield* Effect.promise(async () => {
      const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
      const result = await exec("sh", ["-c", `printf %s ${quoteRemoteArg(value)}`]);
      expect(result.stdout).toBe(value);
    });
  }),
);

describe("remote helper lifecycle", () => {
  it.effect("reuses its own healthy helpers and stops only its own runtime", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      yield* Effect.promise(async () => {
        const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-remote-script-"));
        const bin = NodePath.join(home, "bin");
        await NodeFSP.mkdir(bin);
        await NodeFSP.writeFile(NodePath.join(bin, "adb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const root = NodePath.join(home, ".t3/device");
        const hubDir = NodePath.join(root, `tools/expo-device-hub@${DEVICE_HUB_VERSION}`);
        const agentDir = NodePath.join(root, `tools/agent-device@${AGENT_DEVICE_VERSION}`);
        const hub = NodePath.join(hubDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
        const agent = NodePath.join(agentDir, "node_modules/agent-device/bin/agent-device.mjs");
        await NodeFSP.mkdir(NodePath.join(hubDir, "node_modules/expo-device-hub/dist/server"), {
          recursive: true,
        });
        await NodeFSP.mkdir(NodePath.join(agentDir, "node_modules/agent-device/bin"), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(hubDir, ".install-complete"), DEVICE_HUB_VERSION);
        await NodeFSP.writeFile(NodePath.join(agentDir, ".install-complete"), AGENT_DEVICE_VERSION);
        await NodeFSP.writeFile(
          hub,
          `import http from 'node:http'; import fs from 'node:fs';
if(fs.existsSync('fail-start-once')) {fs.unlinkSync('fail-start-once');process.exit(1);}
const args=process.argv.slice(2); http.createServer((req,res)=>{res.statusCode=fs.existsSync('unhealthy-'+process.pid)?503:200;res.end('ok');}).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
        );
        await NodeFSP.writeFile(
          agent,
          `import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const state=process.env.AGENT_DEVICE_STATE_DIR || args[args.indexOf('--state-dir')+1];
const file=path.join(state,'daemon.json');
if(args[0]==='daemon') { const data=JSON.parse(fs.readFileSync(file,'utf8')); fs.writeFileSync(path.join(state,'stopped-agent'),String(data.pid)); try {process.kill(data.pid,'SIGTERM')} catch {} }
else if(args[0]==='serve') { const server=http.createServer((req,res)=>{res.statusCode=fs.existsSync(path.join(state,'unhealthy-agent-'+process.pid))?503:200;res.end('ok');}); server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(file,JSON.stringify({httpPort:server.address().port,pid:process.pid,token:'test'}));process.send?.('ready');process.disconnect?.();}); }
else { const child=spawn(process.execPath,[process.argv[1],'serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});child.unref(); }
`,
        );
        const nextHubVersion = DEVICE_HUB_VERSION + "-upgrade";
        const nextAgentVersion = AGENT_DEVICE_VERSION + "-upgrade";
        let invocation = 0;
        const invoke = async (
          owner: string,
          mode: "start" | "agent-start" | "stop-agent" | "stop",
          upgraded = false,
        ) => {
          const file = NodePath.join(home, `${owner}-${mode}-${invocation++}.cjs`);
          await NodeFSP.writeFile(
            file,
            `const originalKill = process.kill; process.kill = (pid, signal) => { if (signal === 'SIGTERM') require('node:fs').appendFileSync(${JSON.stringify(NodePath.join(home, "stops"))}, pid+'\\n'); return originalKill(pid, signal); };\n` +
              remoteDeviceScript(owner, mode)
                .replace(DEVICE_HUB_VERSION, upgraded ? nextHubVersion : DEVICE_HUB_VERSION)
                .replace(AGENT_DEVICE_VERSION, upgraded ? nextAgentVersion : AGENT_DEVICE_VERSION),
          );
          const result = await exec(process.execPath, [file], {
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
          });
          return result.stdout ? JSON.parse(result.stdout) : null;
        };
        const template = NodePath.join(home, "hub-template");
        await NodeFSP.cp(hubDir, template, { recursive: true });
        await NodeFSP.rm(NodePath.join(hubDir, ".install-complete"));
        const installLock = hubDir + ".lock";
        await NodeFSP.symlink("2147483647:exited-installer", installLock);
        await NodeFSP.writeFile(
          NodePath.join(bin, "npm"),
          `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.cpSync(${JSON.stringify(template)},args[args.indexOf('--prefix')+1],{recursive:true});`,
          { mode: 0o755 },
        );
        await NodeFSP.mkdir(NodePath.join(root, "hosts/one"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "hosts/one/fail-start-once"), "");
        try {
          const [manual, concurrent] = await Promise.all([
            invoke("one", "start"),
            invoke("one", "start"),
          ]);
          expect(concurrent.hubPort).toBe(manual.hubPort);
          expect(manual.daemonPort).toBeUndefined();
          await expect(
            NodeFSP.stat(NodePath.join(root, "hosts/one/daemon.json")),
          ).rejects.toThrow();
          const [first, concurrentAgent] = await Promise.all([
            invoke("one", "agent-start"),
            invoke("one", "agent-start"),
          ]);
          expect(concurrentAgent.hubPort).toBe(first.hubPort);
          expect(concurrentAgent.daemonPort).toBe(first.daemonPort);
          const second = await invoke("two", "agent-start");
          const reused = await invoke("one", "agent-start");
          expect(reused.hubPort).toBe(first.hubPort);
          expect(reused.daemonPort).toBe(first.daemonPort);
          expect(second.hubPort).not.toBe(first.hubPort);
          expect(second.daemonPort).not.toBe(first.daemonPort);
          const firstHub = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/hub.json"), "utf8"),
          );
          const secondHub = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/two/hub.json"), "utf8"),
          );
          await NodeFSP.writeFile(NodePath.join(root, `hosts/one/unhealthy-${firstHub.pid}`), "");
          let repaired = await invoke("one", "agent-start");
          expect(repaired.hubPort).not.toBe(first.hubPort);
          const stopped = (await NodeFSP.readFile(NodePath.join(home, "stops"), "utf8"))
            .trim()
            .split("\n");
          expect(stopped).toContain(String(firstHub.pid));
          expect(stopped).not.toContain(String(secondHub.pid));
          const previousDaemon = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/daemon.json"), "utf8"),
          );
          for (const [source, name, version] of [
            [hubDir, "expo-device-hub", nextHubVersion],
            [agentDir, "agent-device", nextAgentVersion],
          ]) {
            const destination = NodePath.join(root, `tools/${name}@${version}`);
            await NodeFSP.cp(source!, destination, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(destination, ".install-complete"), version!);
          }
          const upgraded = await invoke("one", "agent-start", true);
          expect(upgraded.entryPath).toContain(nextAgentVersion);
          const upgradedHub = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/hub.json"), "utf8"),
          );
          expect(upgradedHub.entryPath).toContain(nextHubVersion);
          const upgradedDaemon = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/daemon.json"), "utf8"),
          );
          expect(upgradedDaemon.pid).not.toBe(previousDaemon.pid);
          expect(await invoke("one", "agent-start", true)).toEqual(upgraded);
          await NodeFSP.writeFile(
            NodePath.join(root, `hosts/one/unhealthy-agent-${upgradedDaemon.pid}`),
            "",
          );
          repaired = await invoke("one", "agent-start", true);
          expect(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/stopped-agent"), "utf8"),
          ).toBe(String(upgradedDaemon.pid));
          expect(repaired.daemonPort).not.toBe(upgraded.daemonPort);
          // Stop still uses the recorded entry when a future pinned package is not installed yet.
          const originalScript = remoteDeviceScript("one", "stop-agent");
          const upgradedStop = NodePath.join(home, "upgraded-stop.cjs");
          await NodeFSP.writeFile(
            upgradedStop,
            originalScript.replace(AGENT_DEVICE_VERSION, "999.0.0"),
          );
          await exec(process.execPath, [upgradedStop], {
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
          });
          const daemon = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/daemon.json"), "utf8"),
          );
          expect(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/stopped-agent"), "utf8"),
          ).toBe(String(daemon.pid));
          expect((await fetch(`http://127.0.0.1:${repaired.hubPort}/readyz`)).ok).toBe(true);
          await invoke("one", "stop");
          expect((await fetch(`http://127.0.0.1:${second.hubPort}/readyz`)).ok).toBe(true);
          expect(
            JSON.parse(await NodeFSP.readFile(NodePath.join(root, "hosts/two/hub.json"), "utf8"))
              .owner,
          ).toBe("two");
        } finally {
          await invoke("one", "stop").catch(() => {});
          await invoke("two", "stop").catch(() => {});
          await NodeFSP.rm(home, { recursive: true, force: true });
        }
      });
    }),
  );
});

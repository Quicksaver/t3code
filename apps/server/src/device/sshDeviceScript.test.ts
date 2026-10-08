// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import { deviceHubWindowsImport } from "./deviceHubWindows.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

const hubIdentityCases = (["stop", "start"] as const).flatMap((mode) =>
  (
    [
      "match",
      "current",
      "entry-mismatch",
      "port-mismatch",
      "failed",
      "empty",
      "inspection-error",
      "termination-error",
      "still-alive",
      "absent",
      "absent-unix",
      "other-owner",
    ] as const
  ).map((condition) => ({ mode, condition })),
);

it.each(hubIdentityCases)(
  "hub $mode preserves ownership until retirement is established ($condition record)",
  async ({ mode, condition }) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 hub identity "));
    try {
      const root = NodePath.join(home, ".t3/device");
      const state = NodePath.join(root, "hosts/fixture");
      const tool = NodePath.join(root, `tools/expo-device-hub@${DEVICE_HUB_VERSION}`);
      const entry = NodePath.join(tool, "node_modules/expo-device-hub/dist/server/cli.mjs");
      await NodeFSP.mkdir(state, { recursive: true });
      await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
      await NodeFSP.writeFile(entry, "");
      await NodeFSP.writeFile(NodePath.join(tool, ".install-complete"), DEVICE_HUB_VERSION);
      const hub = { owner: "fixture", pid: 12345, port: 54321, entryPath: entry };
      const hubFile = NodePath.join(state, "hub.json");
      const originalRecord = JSON.stringify({
        ...hub,
        owner: condition === "other-owner" ? "another-owner" : hub.owner,
        ...(condition === "current" ? { windowsImport: deviceHubWindowsImport } : {}),
      });
      await NodeFSP.writeFile(hubFile, originalRecord);
      const agentEntry = NodePath.join(state, "agent-device.mjs");
      await NodeFSP.writeFile(agentEntry, "");
      await NodeFSP.writeFile(
        NodePath.join(state, "agent.json"),
        JSON.stringify({ entryPath: agentEntry }),
      );
      const hubCommandLine =
        condition === "entry-mismatch"
          ? `node unrelated.mjs --port ${hub.port}`
          : condition === "port-mismatch"
            ? `node "${entry}" --port 123`
            : `node "${entry}" --port ${hub.port}`;
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(condition === "absent-unix" ? "linux" : "win32")} });
require('node:os').homedir = () => ${JSON.stringify(home)};
const calls = [];
let alive = ${condition !== "absent" && condition !== "absent-unix"};
process.kill = (pid, signal) => {
  if (!alive) throw Object.assign(new Error('missing'), {code:'ESRCH'});
  if (signal === 0) return true;
  calls.push({ pid, signal });
  if (${condition === "termination-error"}) throw Object.assign(new Error('denied'), {code:'EPERM'});
  if (!${condition === "still-alive"}) alive = false;
};
if (${condition === "still-alive"}) { let now = 0; Date.now = () => now += 6000; }
const childProcess = require('node:child_process');
childProcess.spawnSync = (command, args) => {
  if (command === process.execPath) {
    require('node:assert/strict').deepEqual(args, [${JSON.stringify(agentEntry)}, 'daemon', 'stop', '--state-dir', ${JSON.stringify(state)}]);
    calls.push({ daemonStopped: true });
    return {status: 0, stdout: ''};
  }
  return command === 'powershell.exe'
    ? { status: ${condition === "failed" ? 1 : 0}, stdout: ${JSON.stringify(condition === "empty" ? "" : hubCommandLine)}, ...(${condition === "inspection-error"} ? {error: new Error('unavailable')} : {}) }
    : { status: command === 'adb' ? 0 : 1, stdout: '' };
};
childProcess.spawn = (command, args) => {
  if (${condition === "match"} && alive) throw Error('replacement before retirement');
  calls.push({ spawned: args[0] === '--import' });
  const child = new (require('node:events').EventEmitter)();
  Object.assign(child, { pid: 23456, exitCode: null, signalCode: null, unref() {} });
  process.nextTick(() => child.emit('spawn'));
  return child;
};
let healthChecks = 0;
global.fetch = async () => ({ ok: !(healthChecks++ === 0 && ${condition === "absent-unix"}) });
process.on('exit', () => console.log(JSON.stringify({ calls })));
` + remoteDeviceScript("fixture", mode),
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      const failed = [
        "failed",
        "empty",
        "inspection-error",
        "termination-error",
        "still-alive",
      ].includes(condition);
      expect(result.status, result.stderr).toBe(failed ? 1 : 0);
      const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      // A healthy hub already running the current adapter is kept on start.
      const reused = mode === "start" && condition === "current";
      const verified = ["match", "current", "termination-error", "still-alive"].includes(condition);
      expect(output.calls).toEqual([
        ...(verified && !reused ? [{ pid: hub.pid, signal: "SIGTERM" }] : []),
        ...(mode === "start" && !reused && !failed
          ? [{ spawned: condition !== "absent-unix" }]
          : []),
        ...(mode === "stop" ? [{ daemonStopped: true }] : []),
      ]);
      if (failed) {
        expect(result.stderr).toContain(`Could not retire device hub PID ${hub.pid}`);
        expect(result.stderr).toContain(hubFile);
        expect(await NodeFSP.readFile(hubFile, "utf8")).toBe(originalRecord);
      } else if (mode === "start" && !reused) {
        const replacement = JSON.parse(await NodeFSP.readFile(hubFile, "utf8"));
        expect(replacement.pid).toBe(23456);
        if (condition !== "absent-unix")
          expect(replacement.windowsImport).toBe(deviceHubWindowsImport);
      } else if (reused || condition === "other-owner") {
        expect(await NodeFSP.readFile(hubFile, "utf8")).toBe(originalRecord);
      } else {
        await expect(NodeFSP.stat(hubFile)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);

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
else { const child=spawn(process.execPath,[path.join(path.dirname(process.argv[1]),'daemon.mjs'),'serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});child.unref(); }
`,
        );
        await NodeFSP.copyFile(agent, NodePath.join(NodePath.dirname(agent), "daemon.mjs"));
        const nextHubVersion = DEVICE_HUB_VERSION + "-upgrade";
        const nextAgentVersion = AGENT_DEVICE_VERSION + "-upgrade";
        let invocation = 0;
        const invoke = async (
          owner: string,
          mode: "probe" | "start" | "agent-start" | "stop-agent" | "stop",
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
        const inventory = await invoke("one", "probe");
        expect(inventory.tools.hub.installedVersions).toEqual([DEVICE_HUB_VERSION]);
        expect(inventory.tools.hub.runningVersion).toBeNull();
        expect(inventory.tools.agent.installedVersions).toEqual([AGENT_DEVICE_VERSION]);
        await expect(NodeFSP.stat(NodePath.join(root, "hosts/one/hub.json"))).rejects.toThrow();
        const template = NodePath.join(home, "hub-template");
        await NodeFSP.cp(hubDir, template, { recursive: true });
        await NodeFSP.rm(NodePath.join(hubDir, ".install-complete"));
        const installLock = hubDir + ".lock";
        await NodeFSP.symlink("2147483647:exited-installer", installLock);
        await NodeFSP.writeFile(
          NodePath.join(bin, "npm"),
          `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('10.0.0');process.exit(0);}fs.cpSync(${JSON.stringify(template)},args[args.indexOf('--prefix')+1],{recursive:true});`,
          { mode: 0o755 },
        );
        await NodeFSP.mkdir(NodePath.join(root, "hosts/one"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "hosts/one/fail-start-once"), "");
        // Unavailable advisory bookkeeping must not prevent either helper from starting.
        await NodeFSP.writeFile(NodePath.join(root, "tools/.maintenance-lock"), "blocked");
        await NodeFSP.writeFile(NodePath.join(root, "tools/.users"), "unwritable lease directory");
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
          const running = await invoke("one", "probe");
          expect(running.tools.hub.runningVersion).toBe(DEVICE_HUB_VERSION);
          expect(running.tools.agent.runningVersion).toBe(AGENT_DEVICE_VERSION);
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

---
name: update-unattended
description: Use for an unattended update of all worktrees, pick into main, and build all dists to get ready to update whole fleet.
disable-model-invocation: true
---

Follow these steps sequentially:

- use `$update-worktrees`. On blockers, report and do not proceed;
- use `$update-prs` to update open PRs; do not open new ones. Wait ten minutes before starting the next step, to allow the bot reviewers enough time to analyse the pushed changes;
- use `$babysit-worktrees`. Contrarily to that skill's final instructions, do not cherrypick any new commits onto `main` yet as we will be entirely rebuilding in the next step;
- use `$rebuild-main`. If unsuccessful, report and do not proceed;
- push all tracked branches to origin;
- sync `main` branch to the other devices; project is tracked on windows desktop and macbook pro
- cleanup all temporary and leftover branches and stashes created during this process
- build the windows dist on the windows desktop via `pnpm run dist:desktop:win:x64`
- build the macos dist on the macbook pro via `pnpm run dist:desktop:dmg:arm64`
- build the android dist on the macbook pro via (use verbatim):

```bash
cd /Users/luismiguelsousa/Sites/t3code/apps/mobile

EAS_WORKDIR="/Users/luismiguelsousa/.t3-eas-local-$(date +%Y%m%d-%H%M%S)"

EAS_VERSION=21.0.1
APK="./build/android/t3-code-preview-$(date +%Y%m%d-%H%M).apk"

PLUGIN_PATH="$(
  pnpm --package "eas-cli-local-build-plugin@$EAS_VERSION" \
    dlx which eas-cli-local-build-plugin \
    </dev/null
)"

JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools \
PATH="/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:$PATH" \
EAS_LOCAL_BUILD_WORKINGDIR="$EAS_WORKDIR" \
EAS_LOCAL_BUILD_PLUGIN_PATH="$PLUGIN_PATH" \
EAS_SKIP_AUTO_FINGERPRINT=1 \
EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 \
ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a \
pnpm --package "eas-cli@$EAS_VERSION" dlx eas build \
  --profile preview \
  --platform android \
  --local \
  --non-interactive \
  --output "$APK" \
  </dev/null
```

For builds, one task per device sequentially; but devices work simultaneously. Be silent as you patiently wait for the builds to finish. Report only failures.

## When finished

Provide an upstream changelog report: since we're outside the usual app update process, I need a sort of "Release notes" or "Changelog" summary of the changes that affect me and my usage of T3 Code, even if they don't affect my customizations. Based on all new upstream commits integrated in this run (base yourself on titles and bodies only, do not deep dive into diffs), group them by type and list them in your report.

Summarize also all changes made during this run to each branch's work in light of the incoming upstream updates, derived from conflict resolution, from Magi review recommendations, and from PR reviews. Group these by branch and state what changed and why, with a commit short hash linking to the commit where each change was made.

Skip reporting on unchanged behavior, clean merges with no conflicts, or lack of needed action/follow-up on successful and uneventful updates.

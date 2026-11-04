---
name: build-fleet
description: Build all binaries, get it ready to install across the fleet.
disable-model-invocation: true
---

Sync `main` branch across the fleet; project is tracked on windows desktop and macbook pro.

Then, one task per device sequentially; but devices work simultaneously. Be silent as you patiently wait for the builds to finish. Report only failures.

Build tasks:

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

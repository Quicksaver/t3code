const fs = require("node:fs/promises");
const path = require("node:path");
const { withDangerousMod, withProjectBuildGradle } = require("expo/config-plugins");

const scriptName = "t3-react-native-abi.gradle";
const applyScript = `apply from: file("${scriptName}")`;

module.exports = function withAndroidReactNativeAbi(config) {
  config = withDangerousMod(config, [
    "android",
    async (nextConfig) => {
      await fs.copyFile(
        path.join(__dirname, "react-native-abi.gradle"),
        path.join(nextConfig.modRequest.platformProjectRoot, scriptName),
      );
      return nextConfig;
    },
  ]);
  return withProjectBuildGradle(config, (nextConfig) => {
    if (!nextConfig.modResults.contents.includes(applyScript)) {
      nextConfig.modResults.contents += `\n${applyScript}\n`;
    }
    return nextConfig;
  });
};

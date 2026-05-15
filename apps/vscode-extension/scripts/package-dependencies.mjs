export function filterPackagedDependencies(dependencies) {
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).filter(
      ([, version]) => typeof version !== "string" || !version.startsWith("workspace:"),
    ),
  );
}

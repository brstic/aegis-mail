export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && (process.env.AWS_KMS_KEY_ID || process.env.AEGIS_ROOT_KEY || process.env.AEGIS_ROOT_KEY_FILE)) {
    const { initPlatform } = await import("./server/platform");
    await initPlatform();
  }
}

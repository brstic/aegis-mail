declare module "hoodiecrow-imap" {
  interface HoodiecrowServer {
    listen(port: number, host: string, cb: () => void): void;
    close(cb: () => void): void;
    server: { address(): { port: number } };
  }
  export default function hoodiecrow(options: Record<string, unknown>): HoodiecrowServer;
}

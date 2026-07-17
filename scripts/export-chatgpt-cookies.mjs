import { writeFileSync } from "node:fs";
import { getCookies } from "@steipete/sweet-cookie";

const out = process.argv[2];
if (!out) {
  console.error("usage: export-chatgpt-cookies.mjs <outfile.json>");
  process.exit(2);
}

const { cookies } = await getCookies({
  url: "https://chatgpt.com",
  origins: ["https://chatgpt.com", "https://chat.openai.com", "https://atlas.openai.com"],
  browsers: ["chrome"],
  mode: "merge",
  chromeProfile: "Default",
  timeoutMs: 10_000,
});

// CDP CookieParam shape only; drop sweet-cookie metadata that Oracle ignores.
const payload = cookies.map(({ name, value, domain, path, secure, httpOnly, sameSite, expires }) => {
  const cookie = { name, value, domain, path: path ?? "/", secure: secure ?? true, httpOnly: Boolean(httpOnly) };
  if (sameSite === "Lax" || sameSite === "Strict" || sameSite === "None") cookie.sameSite = sameSite;
  if (typeof expires === "number" && expires > 0) cookie.expires = expires;
  return cookie;
});

const hasSession = payload.some((c) => c.name.startsWith("__Secure-next-auth.session-token"));
writeFileSync(out, JSON.stringify(payload));
console.log(`wrote ${payload.length} cookies to ${out}; session=${hasSession}`);
process.exit(hasSession ? 0 : 1);

// Account secrets are only needed by these sign-in adapters. A frame or an
// unrelated page must never receive them merely because it hosts our script.
const domains = [
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "icims.com",
  "icims.eu",
  "successfactors.com",
  "successfactors.eu",
  "sapsf.com",
  "sapsf.eu",
  "ultipro.com",
  "ultipro.ca",
  "careers.tiktok.com",
  "lifeattiktok.com",
  "dayforcehcm.com",
];
export function canReadAccount(sender) {
  try {
    const page = new URL(sender.url),
      tab = new URL(sender.tab?.url);
    return (
      sender.frameId === 0 &&
      page.protocol === "https:" &&
      page.origin === tab.origin &&
      !page.username &&
      !page.password &&
      domains.some(
        (domain) =>
          page.hostname === domain || page.hostname.endsWith("." + domain),
      )
    );
  } catch {
    return false;
  }
}

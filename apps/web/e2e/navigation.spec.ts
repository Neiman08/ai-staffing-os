import { test, expect } from "@playwright/test";

const PAGES: Array<{ path: string; heading: string }> = [
  { path: "/companies", heading: "Companies" },
  { path: "/candidates", heading: "Candidates" },
  { path: "/job-orders", heading: "Job Orders" },
  { path: "/settings", heading: "Settings" },
];

for (const { path, heading } of PAGES) {
  test(`${path} carga sin errores de consola`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

    expect(errors, `console errors on ${path}: ${errors.join("\n")}`).toHaveLength(0);
  });
}

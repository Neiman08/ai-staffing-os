// F4.8: genera robots.txt y sitemap.xml en build/dev time — el dominio
// NUNCA se hardcodea en un archivo fuente. Lee las mismas variables que
// apps/api/src/core/env.ts (mismo nombre, mismo default real ya
// decidido: BUSINESS_DOMAIN=dreistaff.com) — si el dominio cambia algún
// día, cambia acá y en el backend, en un solo lugar cada uno, nunca en
// el HTML/JS del sitio.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
mkdirSync(publicDir, { recursive: true });

const domain = process.env.BUSINESS_DOMAIN || "dreistaff.com";
const origin = `https://${domain}`;

const routes = ["/", "/employers", "/candidates", "/industries", "/about", "/contact", "/request-talent", "/careers", "/privacy", "/terms"];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map((r) => `  <url><loc>${origin}${r}</loc><changefreq>weekly</changefreq></url>`).join("\n")}
</urlset>
`;

const robots = `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;

writeFileSync(join(publicDir, "sitemap.xml"), sitemap);
writeFileSync(join(publicDir, "robots.txt"), robots);

console.log(`[generate-seo-files] robots.txt + sitemap.xml generados para ${origin}`);

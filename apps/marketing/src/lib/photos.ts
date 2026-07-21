/**
 * F4.8A: fotografía corporativa real, con licencia libre (Unsplash —
 * uso comercial permitido, sin atribución requerida), nunca
 * ilustraciones/renders/IA evidente. Centralizada acá como el resto de
 * los tokens del sistema (nunca una URL suelta dentro de un
 * componente). Cada URL fue verificada manualmente (curl -I → 200)
 * antes de agregarse. `Photo.tsx` además nunca deja un ícono de imagen
 * rota si alguna llegara a fallar en producción.
 */
function unsplash(id: string, params = "w=1600&q=80&auto=format&fit=crop"): string {
  return `https://images.unsplash.com/photo-${id}?${params}`;
}

export const PHOTOS = {
  heroOfficeCollaboration: {
    // F4.8B: resolución elevada a propósito (w=2400 en vez del default
    // 1600) — este asset ahora es un fondo full-bleed a todo el ancho
    // del hero (ver Hero.tsx), no una tarjeta acotada; con 1600px se ve
    // borroso en monitores anchos/retina a ese tamaño de renderizado.
    src: unsplash("1522071820081-009f0129c71c", "w=2400&q=80&auto=format&fit=crop"),
    alt: "Two professionals reviewing work together in a modern office",
  },
  handshakeInterview: {
    src: unsplash("1521737604893-d14cc237f11d"),
    alt: "Interview handshake between two professionals",
  },
  warehouseLogistics: {
    src: unsplash("1553413077-190dd305871c"),
    alt: "Warehouse worker managing logistics operations",
  },
  constructionSite: {
    src: unsplash("1541888946425-d81bb19240f5"),
    alt: "Construction site with workers in safety gear",
  },
  dataCenterServerRoom: {
    src: unsplash("1544197150-b99a580bb7a8"),
    alt: "Data center server room with rows of equipment",
  },
  manufacturingFloor: {
    src: unsplash("1581091226825-a6a2a5aee158"),
    alt: "Industrial manufacturing floor with equipment",
  },
  professionalPortraitWoman: {
    src: unsplash("1573497019940-1c28c88b4f3e"),
    alt: "Professional businesswoman portrait",
  },
  professionalPortraitMan: {
    src: unsplash("1519085360753-af0119f7cbe7"),
    alt: "Professional businessman portrait",
  },
  officeTeamMeeting: {
    src: unsplash("1600880292203-757bb62b4baf"),
    alt: "Team collaborating around a table in an office",
  },
  warehouseAisles: {
    src: unsplash("1586528116311-ad8dd3c8310d"),
    alt: "Warehouse storage aisles with inventory",
  },
  electricalTrade: {
    src: unsplash("1621905251189-08b45d6a269e"),
    alt: "Skilled trade electrician at work",
  },
  officeInterior: {
    src: unsplash("1504384308090-c894fdcc538d"),
    alt: "Open-plan office with employees working at rows of desks",
  },
  weldingSkilledTrade: {
    src: unsplash("1504328345606-18bbc8c9d7d1"),
    alt: "Welder at work with sparks flying — skilled trade craftsmanship",
  },
  corporateBuildingExterior: {
    src: unsplash("1487958449943-2429e8be8625"),
    alt: "Modern glass corporate office building exterior",
  },
  teamMeetingDiscussion: {
    src: unsplash("1517245386807-bb43f82c33c4"),
    alt: "Team discussing work around a table with a laptop",
  },
} as const;

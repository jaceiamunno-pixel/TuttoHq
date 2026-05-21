// Shared, runtime-free types for spec-book TOC parsing and project scope.
// Pure types only — safe to import from both server (unpdf) and client code.

export interface TocEntry {
  specNumber: string    // normalized "03 30 00"
  specTitle: string     // "Cast-in-Place Concrete"
  divisionCode: string  // "03"
}

export interface TocDivision {
  code: string          // "03"
  name: string          // "Concrete"
  sectionCount: number
}

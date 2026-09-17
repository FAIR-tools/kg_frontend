"""
app/units.py
------------
Unit handling for quantities stored as nodes.

atomrdf writes every measured quantity as its own node carrying both a value and
a QUDT unit:

    ?p a asmo:GrainBoundaryEnergy ; asmo:hasValue 0.899 ; asmo:hasUnit qudt:J-PER-M2 .

That is what makes a collection assembled from many published datasets safe: the
same property can arrive in different units, and here it does. GrainBoundaryEnergy
is 19,768 records in mJ/m² and 16,359 in J/m² (counting every property type that
uses each), so 0.899 and 418.6 both appear and differ by a factor of 1000. Any
aggregate or filter that ignores the unit is wrong by that factor.

The graph itself is left exactly as published -- each value keeps the unit its
source dataset stated, so the RDF still matches the paper and Zenodo record it
came from. Normalisation happens here, on read, and is always reported alongside
the result so nothing is silently rescaled.
"""

from __future__ import annotations

# QUDT unit local name -> (dimension, factor to that dimension's base unit).
# Only units that actually occur in the graph are listed; anything else is
# treated as unconvertible rather than guessed at.
_TO_BASE: dict[str, tuple[str, float]] = {
    # energy per area, base J/m²
    "J-PER-M2": ("energy_per_area", 1.0),
    "MilliJ-PER-M2": ("energy_per_area", 1e-3),
    # energy, base eV
    "EV": ("energy", 1.0),
    # length, base Å
    "ANGSTROM": ("length", 1.0),
    # volume, base Å³
    "ANGSTROM3": ("volume", 1.0),
    # pressure, base Pa
    "PA": ("pressure", 1.0),
    # temperature, base K
    "K": ("temperature", 1.0),
    # charge, base e
    "E": ("charge", 1.0),
    # reciprocal area, base 1/Å²
    "PER-ANGSTROM2": ("per_area", 1.0),
}

# Preferred unit per dimension when a property type mixes units. mJ/m² wins for
# interface energies: it is the majority in this collection and the convention in
# the grain-boundary literature, where values run a few hundred to ~1500.
_PREFERRED: dict[str, str] = {
    "energy_per_area": "MilliJ-PER-M2",
}


def local_name(unit: str | None) -> str:
    """QUDT IRI or bare name -> bare name. '' for a missing unit."""
    if not unit:
        return ""
    return str(unit).rstrip("/").split("/")[-1].split("#")[-1]


def dimension(unit: str | None) -> str:
    """Physical dimension of a unit, or '' when it is not one we know."""
    entry = _TO_BASE.get(local_name(unit))
    return entry[0] if entry else ""


def convertible(a: str | None, b: str | None) -> bool:
    """True when both units are known and share a dimension."""
    da, db = dimension(a), dimension(b)
    return bool(da) and da == db


def convert(value, frm: str | None, to: str | None):
    """
    Convert value between two units of the same dimension.

    Returns None when the conversion is not defined, so callers must decide what
    to do rather than silently receiving an unscaled number.
    """
    if value is None:
        return None
    fa, fb = _TO_BASE.get(local_name(frm)), _TO_BASE.get(local_name(to))
    if not fa or not fb or fa[0] != fb[0]:
        return None
    try:
        return float(value) * fa[1] / fb[1]
    except (TypeError, ValueError):
        return None


def canonical_unit(units) -> str:
    """
    Pick the unit to report a mixed-unit property type in.

    A configured preference for the dimension wins; otherwise the most common
    unit in the data does. `units` is an iterable of (unit, count).
    """
    counts = [(local_name(u), n) for u, n in units if local_name(u)]
    if not counts:
        return ""
    if len(counts) == 1:
        return counts[0][0]
    dims = {dimension(u) for u, _ in counts}
    if len(dims) == 1:
        preferred = _PREFERRED.get(next(iter(dims)))
        if preferred and any(u == preferred for u, _ in counts):
            return preferred
    return max(counts, key=lambda c: c[1])[0]

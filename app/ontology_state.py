"""
Loads and caches the merged ontology (CMSO + ASMO + PLDO + LDO) at startup.
Provides helpers to list classes and properties reachable from a given class.

NOTE: The purls.helmholtz-metadaten.de PURL server returns 404 for content-
negotiated RDF requests on CDOS ontologies (pldo, podo, ldo, cdco).  We work
around this by loading the OWL files directly from GitHub.
"""

from __future__ import annotations
from functools import lru_cache
from tools4rdf.network.parser import parse_ontology
from tools4rdf.network.network import OntologyNetworkBase

_onto = None

# Direct GitHub raw URLs for ontologies whose PURLs are broken for RDF
_ONTOLOGY_URLS = {
    "cmso": "https://purls.helmholtz-metadaten.de/cmso/",
    "asmo": "https://purls.helmholtz-metadaten.de/asmo/",
    "pldo": "https://raw.githubusercontent.com/OCDO/pldo/main/pldo.owl",
    "podo": "https://raw.githubusercontent.com/OCDO/podo/main/podo.owl",
    "ldo":  "https://raw.githubusercontent.com/OCDO/ldo/main/ldo.owl",
    "cdco": "https://raw.githubusercontent.com/OCDO/cdco/main/cdco.owl",
}


def _read_ontology():
    """Equivalent to atomrdf.ontology.read_ontology() but with working URLs."""
    cmso = parse_ontology(_ONTOLOGY_URLS["cmso"])
    pldo = parse_ontology(_ONTOLOGY_URLS["pldo"])
    podo = parse_ontology(_ONTOLOGY_URLS["podo"])
    asmo = parse_ontology(_ONTOLOGY_URLS["asmo"])
    ldo  = parse_ontology(_ONTOLOGY_URLS["ldo"])
    cdco = parse_ontology(_ONTOLOGY_URLS["cdco"])

    combo = cmso + cdco + pldo + podo + asmo + ldo
    combo.attributes["data_property"]["cmso:hasSymbol"].range.append("str")
    combo.attributes["data_property"]["asmo:hasValue"].range.extend(
        ["float", "double", "int", "str"]
    )

    combo = OntologyNetworkBase(combo)
    combo.add_namespace("rdfs", "http://www.w3.org/2000/01/rdf-schema#")
    combo.add_term(
        "http://www.w3.org/2000/01/rdf-schema#label",
        "data_property",
        delimiter="#",
        namespace="rdfs",
        rn=["str"],
    )
    combo.add_path(("asmo:CalculatedProperty", "rdfs:label", "string"))
    combo.add_path(("asmo:InputParameter", "rdfs:label", "string"))
    combo.add_path(("prov:SoftwareAgent", "rdfs:label", "string"))
    combo.add_path(("asmo:InteratomicPotential", "rdfs:label", "string"))

    return combo


def get_onto():
    global _onto
    if _onto is None:
        _onto = _read_ontology()
    return _onto


@lru_cache(maxsize=1)
def get_class_list() -> list[dict]:
    """Return all owl:Class terms as [{uri, label, namespace}]."""
    onto = get_onto()
    classes = []
    # Walk every namespace in onto.terms
    for ns_key in dir(onto.terms):
        ns_obj = getattr(onto.terms, ns_key)
        for term_key in dir(ns_obj):
            try:
                term = getattr(ns_obj, term_key)
            except Exception:
                continue
            # Only include class-type terms
            if getattr(term, "node_type", None) == "class":
                classes.append(
                    {
                        "uri": str(term.uri),
                        "label": term_key,
                        "namespace": ns_key,
                    }
                )
    # Deduplicate by URI
    seen = set()
    unique = []
    for c in classes:
        if c["uri"] not in seen:
            seen.add(c["uri"])
            unique.append(c)
    unique.sort(key=lambda x: x["label"])
    return unique


def get_properties_for_class(class_uri: str) -> list[dict]:
    """
    Return all data/object properties reachable from class_uri
    via shortest paths in the ontology graph.
    Returns [{uri, label, namespace, property_type}].
    """
    onto = get_onto()
    props = []
    seen_uris = set()

    for ns_key in dir(onto.terms):
        ns_obj = getattr(onto.terms, ns_key)
        for term_key in dir(ns_obj):
            try:
                term = getattr(ns_obj, term_key)
            except Exception:
                continue
            ptype = getattr(term, "node_type", None)
            if ptype not in ("data_property", "object_property"):
                continue
            term_uri = str(term.uri)
            if term_uri in seen_uris:
                continue
            # Check that there's a path from class_uri to this property
            try:
                source_term = _find_term_by_uri(class_uri)
                if source_term is None:
                    continue
                paths = onto.get_shortest_path(source_term, term, num_paths=1)
                if paths:
                    seen_uris.add(term_uri)
                    props.append(
                        {
                            "uri": term_uri,
                            "label": term_key,
                            "namespace": ns_key,
                            "property_type": ptype,
                        }
                    )
            except Exception:
                continue
    props.sort(key=lambda x: x["label"])
    return props


def _find_term_by_uri(uri: str):
    """Lookup an OntoTerm by its URI string."""
    onto = get_onto()
    for ns_key in dir(onto.terms):
        ns_obj = getattr(onto.terms, ns_key)
        for term_key in dir(ns_obj):
            try:
                term = getattr(ns_obj, term_key)
            except Exception:
                continue
            if str(getattr(term, "uri", "")) == uri:
                return term
    return None

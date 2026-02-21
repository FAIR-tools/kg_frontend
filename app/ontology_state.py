"""
Loads and caches the merged ontology (CMSO + ASMO + PLDO + LDO) at startup.
Provides helpers to list classes and properties reachable from a given class.
"""

from __future__ import annotations
from functools import lru_cache
from atomrdf.ontology import read_ontology

_onto = None


def get_onto():
    global _onto
    if _onto is None:
        _onto = read_ontology()
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

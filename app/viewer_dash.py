"""
Crystal Toolkit structure viewer — Dash WSGI sub-app mounted at /viewer/.

URL: /viewer/?id=<sample_id>&name=<display_name>

The app is mounted with a prefix-rewriting WSGI shim so that
requests_pathname_prefix="/viewer/" works correctly when Starlette's Mount
strips the /viewer prefix from PATH_INFO.
"""

from __future__ import annotations

import dash
from dash import dcc, html, Input, Output, no_update
from pymatgen.core import Structure, Lattice

import crystal_toolkit.components as ctc
from crystal_toolkit.settings import SETTINGS


def _placeholder() -> Structure:
    """Silicon diamond — shown before a sample is selected."""
    return Structure(
        Lattice.cubic(5.43),
        ["Si", "Si"],
        [[0, 0, 0], [0.25, 0.25, 0.25]],
    )


def create_viewer_app() -> dash.Dash:
    app = dash.Dash(
        __name__,
        requests_pathname_prefix="/viewer/",
        assets_folder=SETTINGS.ASSETS_PATH,
        prevent_initial_callbacks=True,
    )

    struct_component = ctc.StructureMoleculeComponent(
        _placeholder(),
        id="ctk-structure",
    )

    layout = html.Div(
        [
            dcc.Location(id="ctk-url", refresh=False),
            html.Div(
                [
                    html.Div(
                        id="ctk-title",
                        style={
                            "color": "#c8d0f0",
                            "fontFamily": "Inter, system-ui, sans-serif",
                            "fontSize": "16px",
                            "fontWeight": "500",
                        },
                    ),
                    html.Div(
                        id="ctk-error",
                        style={
                            "color": "#ef9a9a",
                            "fontFamily": "Inter, system-ui, sans-serif",
                            "fontSize": "13px",
                            "marginTop": "6px",
                        },
                    ),
                ],
                style={"padding": "16px 24px 8px"},
            ),
            struct_component.layout(),
        ],
        style={"background": "#0d0f18", "minHeight": "100vh"},
    )

    ctc.register_crystal_toolkit(app=app, layout=layout)

    @app.callback(
        Output(struct_component.id(), "data"),
        Output("ctk-title", "children"),
        Output("ctk-error", "children"),
        Input("ctk-url", "search"),
    )
    def load_from_url(search: str | None):  # type: ignore[return]
        if not search:
            return no_update, "Select a sample to view its structure", ""

        from urllib.parse import parse_qs
        from app.graph_state import get_kg
        from pymatgen.io.ase import AseAtomsAdaptor

        params = parse_qs(search.lstrip("?"))
        sample_id = params.get("id", [None])[0]
        name = params.get("name", ["Structure"])[0]

        if not sample_id:
            return no_update, "No structure selected", ""

        try:
            kg = get_kg()
            sample = kg.get_sample_as_structure(sample_id)
            ase_atoms = sample.to_structure()
            structure = AseAtomsAdaptor().get_structure(ase_atoms)
            return structure, name, ""
        except Exception as exc:
            return no_update, name, f"Error loading structure: {exc}"

    return app


class _AddPrefixWSGI:
    """
    Starlette's Mount strips the mount-point prefix from PATH_INFO before
    handing off to the WSGI app.  Dash's requests_pathname_prefix needs the
    full path (e.g. /viewer/_dash-layout).  This wrapper adds the prefix back.
    """

    def __init__(self, wsgi_app, prefix: str):
        self._app = wsgi_app
        self._prefix = prefix.rstrip("/")

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "/")
        environ["PATH_INFO"] = self._prefix + path
        environ["SCRIPT_NAME"] = ""
        return self._app(environ, start_response)


# Module-level singleton — created once on import
_viewer = create_viewer_app()
viewer_wsgi = _AddPrefixWSGI(_viewer.server, "/viewer")

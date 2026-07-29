#!/usr/bin/env python3
"""Validate Step 12 GUI workflow generation: graph preservation + widget changes.

Compares the source GUI workflow against the generated runtime-policy GUI
workflow and the diff-summary claims. Exits non-zero on any mismatch.
"""
import json
import sys

ART = "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts"
SRC = f"{ART}/11-delivery/workflows/source-workflow.json"
GUI = f"{ART}/12-gui-acceptance/12-runtime-policy-gui-workflow.json"
DIFF = f"{ART}/12-gui-acceptance/12-workflow-diff-summary.json"


def graph(d):
    return {
        "nodes": len(d.get("nodes", [])),
        "links": len(d.get("links", [])),
        "last_node_id": d.get("last_node_id"),
        "last_link_id": d.get("last_link_id"),
    }


def main():
    src = json.load(open(SRC))
    gui = json.load(open(GUI))
    diff = json.load(open(DIFF))

    g_src = graph(src)
    g_gui = graph(gui)
    ok = True

    print("source graph:", g_src)
    print("gui    graph:", g_gui)
    for k in g_src:
        if g_src[k] != g_gui[k]:
            print(f"FAIL: {k} differs: source={g_src[k]} gui={g_gui[k]}")
            ok = False
        else:
            print(f"OK:   {k} unchanged = {g_src[k]}")

    s = diff.get("source_workflow", {})
    g = diff.get("gui_workflow", {})
    for k in ("nodes", "links", "last_node_id", "last_link_id"):
        if s.get(k) != g_src[k]:
            print(f"FAIL: diff source_workflow.{k}={s.get(k)} != actual {g_src[k]}")
            ok = False
        if g.get(k) != g_gui[k]:
            print(f"FAIL: diff gui_workflow.{k}={g.get(k)} != actual {g_gui[k]}")
            ok = False

    topo = diff.get("graph_topology", {})
    for k in ("nodes_added", "nodes_removed", "nodes_bypassed", "nodes_replaced",
              "links_added", "links_removed"):
        if topo.get(k) != 0:
            print(f"FAIL: graph_topology.{k}={topo.get(k)} expected 0")
            ok = False
    if topo.get("last_node_id_unchanged") is not True:
        print("FAIL: last_node_id_unchanged not true")
        ok = False
    if topo.get("last_link_id_unchanged") is not True:
        print("FAIL: last_link_id_unchanged not true")
        ok = False
    if topo.get("preservation") != "exact":
        print(f"FAIL: preservation={topo.get('preservation')} expected exact")
        ok = False

    changes = diff.get("workflow_json_widget_changes", [])
    nodes_by_id = {n.get("id"): n for n in gui.get("nodes", [])}
    for ch in changes:
        nid = ch["node_id"]
        node = nodes_by_id.get(nid)
        if node is None:
            print(f"FAIL: claimed widget change on missing node {nid}")
            ok = False
            continue
        wv = node.get("widgets_values", [])
        widget = ch["widget"]
        new_val = ch["new_value"]
        if isinstance(wv, dict):
            if widget not in wv:
                print(f"FAIL: node {nid} widget key '{widget}' not in widgets_values keys {list(wv.keys())}")
                ok = False
            elif wv[widget] != new_val:
                print(f"FAIL: node {nid} widget '{widget}' = {wv[widget]!r} expected {new_val!r}")
                ok = False
            else:
                print(f"OK:   node {nid} widget '{widget}' = {new_val!r}")
        else:
            if new_val not in wv:
                print(f"FAIL: node {nid} widget '{widget}' new_value {new_val!r} not in widgets_values {wv}")
                ok = False
            else:
                print(f"OK:   node {nid} widget '{widget}' = {new_val!r} present")

    if ok:
        print("\nVALIDATION PASSED: graph preserved, widget changes confirmed")
        sys.exit(0)
    else:
        print("\nVALIDATION FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()

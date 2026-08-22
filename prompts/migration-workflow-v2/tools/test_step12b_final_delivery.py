#!/usr/bin/env python3
"""Unit tests for step12b_final_delivery — the two Step-13-verified fixes:
  * 01-assets.csv column mapping (asset_name/resolved_path, not requested_asset)
  * FRONTEND_ONLY_NODES excluded from the dry-run missing_node_types check

Run: python3 -m unittest test_step12b_final_delivery  (from the tools/ dir)
Stdlib-only; no ComfyUI venv or network needed.
"""
import unittest

import step12b_final_delivery as m


def _bundle(**over):
    b = dict(
        comfy_root="/nfs_share/comfyui-core",
        comfy_commit="abc123",
        runtime="docker",
        docker_image="img:latest",
        api_url="http://127.0.0.1:8189",
        task_id="task-x",
        node_types=["KSampler"],
        asset_rows=[],
        custom_node_rows=[],
    )
    b.update(over)
    return b


class AssetColumnMapping(unittest.TestCase):
    def test_real_headers_render_name_and_path(self):
        # 01-assets.csv real headers (assetAcquisition.ts).
        guide = m.render_deployment_guide(
            _bundle(asset_rows=[{"asset_name": "wan22.safetensors", "resolved_path": "/nfs_share/models/wan22.safetensors"}])
        )
        self.assertIn("wan22.safetensors", guide)
        self.assertIn("/nfs_share/models/wan22.safetensors", guide)

    def test_staged_path_fallback_when_no_resolved(self):
        guide = m.render_deployment_guide(
            _bundle(asset_rows=[{"asset_name": "x.gguf", "staged_path": "/nfs_share/input/x.gguf"}])
        )
        self.assertIn("/nfs_share/input/x.gguf", guide)

    def test_legacy_headers_still_supported(self):
        guide = m.render_deployment_guide(
            _bundle(asset_rows=[{"requested_asset": "legacy.ckpt", "resolved_path": "/p/legacy.ckpt"}])
        )
        self.assertIn("legacy.ckpt", guide)


class FrontendOnlyExclusion(unittest.TestCase):
    def setUp(self):
        self._orig = m.http_json

    def tearDown(self):
        m.http_json = self._orig

    def _patch_object_info(self, keys):
        def fake(url):
            if url.endswith("/object_info"):
                return ({k: {} for k in keys}, None)
            return ({"ok": True}, None)  # system_stats
        m.http_json = fake

    def test_frontend_only_node_not_flagged_missing(self):
        # MarkdownNote has no backend class -> absent from /object_info -> must NOT be "missing".
        self._patch_object_info(["KSampler"])
        res = m.build_dry_run_verification(_bundle(node_types=["KSampler", "MarkdownNote"]), "http://127.0.0.1:8189")
        self.assertEqual(res["missing_node_types"], [])

    def test_genuine_missing_node_still_flagged(self):
        self._patch_object_info(["KSampler"])
        res = m.build_dry_run_verification(_bundle(node_types=["KSampler", "TotallyRealCustomNode"]), "http://127.0.0.1:8189")
        self.assertEqual(res["missing_node_types"], ["TotallyRealCustomNode"])

    def test_constant_covers_the_usual_frontend_nodes(self):
        for t in ("MarkdownNote", "Note", "Reroute"):
            self.assertIn(t, m.FRONTEND_ONLY_NODES)


class DockerLaunchScript(unittest.TestCase):
    def test_recorded_launch_command_is_source_of_truth(self):
        cmd = "docker create --name comfyui-task-x --net=host --entrypoint /venv/py img /comfyui/main.py --port 8189"
        script = m.render_docker_launch_script(_bundle(runtime="docker", launch_command=cmd))
        self.assertIn(cmd, script)                      # recorded command replayed verbatim
        self.assertIn("docker start", script)           # started if it was a `create`
        self.assertNotIn("${VENV_PYTHON}", script)      # no dangling unassigned var
        self.assertNotIn("--extra-model-paths-yaml", script)
        self.assertNotIn("--port 8188", script)         # not the hardcoded fallback port

    def test_fallback_template_assigns_venv_and_correct_flag(self):
        # No launch_command recorded -> self-contained tar-copy fallback, but fixed:
        # VENV_PYTHON assigned, correct port, correct --config flag.
        script = m.render_docker_launch_script(
            _bundle(runtime="docker", launch_command="", venv_python="/nfs_share/venv/bin/python3", comfyui_port="8190")
        )
        self.assertIn('VENV_PYTHON="/nfs_share/venv/bin/python3"', script)
        self.assertIn("--port ${COMFYUI_PORT}", script)
        self.assertIn('COMFYUI_PORT="8190"', script)
        self.assertIn("--extra-model-paths-config", script)
        self.assertNotIn("--extra-model-paths-yaml", script)


if __name__ == "__main__":
    unittest.main()

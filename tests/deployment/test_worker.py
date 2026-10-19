import contextlib
import io
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops/deploy"))
import server


class StopProbe(BaseException):
    pass


class ControllerWorker(unittest.TestCase):
    def test_transient_command_failure_does_not_kill_restoration_or_later_deployments(self):
        for failure in (subprocess.CalledProcessError(1, ["synthetic-private-command"]),
                        subprocess.TimeoutExpired(["synthetic-private-command"], 10)):
            with self.subTest(failure=type(failure).__name__):
                engine = Mock()
                engine.records.pending.side_effect = [[], [{"operationId": "later-operation"}], []]
                engine.restore_runtime.side_effect = [failure, True]
                engine.drive.return_value = {"phase": "complete"}
                output = io.StringIO()
                with patch.object(server, "engine", engine), contextlib.redirect_stdout(output), \
                     patch.object(server.time, "sleep", side_effect=[None, None, StopProbe()]):
                    with self.assertRaises(StopProbe):
                        server.work()
                self.assertEqual(engine.restore_runtime.call_count, 2)
                engine.drive.assert_called_once_with("later-operation")
                self.assertIn("runtime_prerequisite_unavailable", output.getvalue())
                self.assertNotIn("synthetic-private-command", output.getvalue())


if __name__ == "__main__":
    unittest.main()

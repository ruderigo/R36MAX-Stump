"""admin_password.py: is the /admin password still SandBox_Stump_On's, set
it with the Stump's own settings.write_config, never print it. With
STUMP_ON=path/to/SandBox_Stump_On, that repo's real settings.py and config.py."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "admin_password.py")
FAKE_SETTINGS = '''
def write_config(changes, path):
    lines = open(path).read().split("\\n")
    for k, v in changes.items():
        for i, l in enumerate(lines):
            if l.startswith(k + " ="):
                lines[i] = "%s = %r" % (k, v)
    open(path, "w").write("\\n".join(lines))
    return True
'''


class AdminPassword(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="stump-")
        self.addCleanup(shutil.rmtree, self.d, True)
        self.stump = os.path.join(self.d, "Stump")
        os.makedirs(self.stump)
        on = os.environ.get("STUMP_ON")
        if on:
            shutil.copy(os.path.join(on, "final_firmware", "settings.py"), self.stump)
            self.template = os.path.join(on, "final_firmware", "config.py")
        else:
            with open(os.path.join(self.stump, "settings.py"), "w") as f:
                f.write(FAKE_SETTINGS)
            self.template = os.path.join(self.d, "template.py")
            with open(self.template, "w") as f:
                f.write("NODE_NAME = 'x'\nAUTH_ADMIN_PASSWORD = 'from-the-repo'\nAUTH_MODE = 'open'\n"
                    "FSERVBOT_OP_PASSWORD = ''\n")
        shutil.copy(self.template, os.path.join(self.stump, "config.py"))      # what the wizard leaves

    def run_tool(self, *args, stdin=""):
        p = subprocess.run([sys.executable, TOOL, "--stump", self.stump] + list(args), input=stdin,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        return p.stdout.strip()

    def test_default_then_set_from_the_answers(self):
        self.assertEqual(self.run_tool("--template", self.template, "state"), "DEFAULT")
        ans = os.path.join(self.d, "a.json")
        with open(ans, "w") as f:
            json.dump({"node name": "R36", "_admin password": "s3cret-pw"}, f)
        out = self.run_tool("--answers", ans)
        self.assertEqual(out, "SET")
        self.assertNotIn("s3cret-pw", out)
        self.assertEqual(self.run_tool("--template", self.template, "state"), "SET")
        with open(os.path.join(self.stump, "config.py")) as f:
            self.assertIn("AUTH_ADMIN_PASSWORD = 's3cret-pw'", f.read())
        self.assertTrue(os.path.isfile(os.path.join(self.stump, "config.py.bak")))

    def test_one_password_as_team_stump_means_it(self):
        """The repo's AUTH_ADMIN_PASSWORD cleared: /admin takes the fserv operator's."""
        self.assertEqual(self.run_tool("--template", self.template, "state"), "DEFAULT")
        self.assertEqual(self.run_tool("one", stdin="abc\n"), "SHORT")
        out = self.run_tool("one", stdin="one-pass\n")
        self.assertEqual(out, "SET")
        with open(os.path.join(self.stump, "config.py")) as f:
            text = f.read()
        self.assertIn("AUTH_ADMIN_PASSWORD = ''", text)
        self.assertIn("FSERVBOT_OP_PASSWORD = 'one-pass'", text)
        self.assertEqual(self.run_tool("--template", self.template, "state"), "EMPTY")
        self.assertEqual(self.run_tool("--key", "FSERVBOT_OP_PASSWORD", "--template", self.template, "state"), "SET")
        shutil.copy(self.template, os.path.join(self.stump, "config.py"))
        self.assertEqual(self.run_tool("clear"), "SET")
        self.assertEqual(self.run_tool("--template", self.template, "state"), "EMPTY")

    def test_set_from_stdin_short_and_nothing(self):
        self.assertEqual(self.run_tool("set", stdin="abc\n"), "SHORT")
        self.assertEqual(self.run_tool("set", stdin="quatre4\n"), "SET")
        ans = os.path.join(self.d, "a.json")
        with open(ans, "w") as f:
            json.dump({"node name": "R36"}, f)
        self.assertEqual(self.run_tool("--answers", ans), "NOTHING")         # an update: kept
        self.assertEqual(self.run_tool("--template", self.template, "state"), "SET")
        # The fserv operator's, apart.
        self.assertEqual(self.run_tool("--key", "FSERVBOT_OP_PASSWORD", "set", stdin="op-pass\n"), "SET")
        with open(os.path.join(self.stump, "config.py")) as f:
            text = f.read()
        self.assertIn("FSERVBOT_OP_PASSWORD = 'op-pass'", text)
        self.assertIn("AUTH_ADMIN_PASSWORD = 'quatre4'", text)
        self.assertIn("not a password", self.run_tool("--key", "NODE_NAME", "set", stdin="xxxx\n"))
        shutil.rmtree(self.stump)
        self.assertEqual(self.run_tool("--template", self.template, "state"), "NONE")


if __name__ == "__main__":
    sys.exit(0 if unittest.main(verbosity=1, exit=False).result.wasSuccessful() else 1)

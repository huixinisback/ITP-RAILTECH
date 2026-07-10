import sys
import unittest
from unittest.mock import patch


class InitDefaultUsersTest(unittest.TestCase):
    def test_initializes_default_users_when_store_is_empty(self):
        sys.modules.pop("app", None)

        with patch("services.auth_service.get_users", return_value=[]), patch("services.auth_service.save_users") as save_users:
            import app

            self.assertIsNotNone(app.app)
            saved_users = save_users.call_args[0][0]
            self.assertEqual([user["user_id"] for user in saved_users], ["admin", "maint01", "ops01"])


if __name__ == "__main__":
    unittest.main()

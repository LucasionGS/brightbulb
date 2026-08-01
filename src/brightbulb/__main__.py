"""Entry point."""

from __future__ import annotations

import logging
import os
import sys


def main() -> int:
    logging.basicConfig(
        level=logging.DEBUG if os.environ.get("BRIGHTBULB_DEBUG") else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    # Imported after logging is configured so gi's own warnings are captured.
    from brightbulb.app import BrightBulbApplication

    return BrightBulbApplication().run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())

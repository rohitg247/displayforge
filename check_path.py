# save as check_path.py
from server.config import settings
print("FastAPI is using DB at:", settings.DATABASE_PATH)

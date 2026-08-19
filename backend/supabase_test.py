from dotenv import load_dotenv
import os
from supabase import create_client

load_dotenv()

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")

supabase = create_client(url, key)

data = {
    "suggestion": "Install more charging ports in the library.",
    "spam": "No",
    "feasibility": "Feasible",
    "category": "Facilities",
    "reason": "Improves student facilities without affecting academics.",
    "summary": "Students request more charging ports.",
    "votes": 0
}

response = supabase.table("suggestions").insert(data).select("id").execute()

print(response)
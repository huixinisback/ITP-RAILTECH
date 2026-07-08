import requests

BASE_URL = "http://127.0.0.1:5000"

payload = {
    "train_id": "PV104",
    "mileage": 23123,
    "source": "pi_simulation"
}

response = requests.post(f"{BASE_URL}/api/submit-scan", json=payload)

print("Status Code:", response.status_code)
print("Response:", response.json())
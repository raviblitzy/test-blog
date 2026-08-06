from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

# In-memory storage
items = []

class Item(BaseModel):
    id: int
    name: str
    price: float

# Create
@app.post("/items")
def create_item(item: Item):
    items.append(item)
    return {"message": "Item created", "data": item}

# Read All
@app.get("/items")
def get_items():
    return items

# Read One
@app.get("/items/{item_id}")
def get_item(item_id: int):
    for item in items:
        if item.id == item_id:
            return item
    raise HTTPException(status_code=404, detail="Item not found")

# Update
@app.put("/items/{item_id}")
def update_item(item_id: int, updated_item: Item):
    for index, item in enumerate(items):
        if item.id == item_id:
            items[index] = updated_item
            return {"message": "Item updated", "data": updated_item}
    raise HTTPException(status_code=404, detail="Item not found")

# Delete
@app.delete("/items/{item_id}")
def delete_item(item_id: int):
    for index, item in enumerate(items):
        if item.id == item_id:
            items.pop(index)
            return {"message": "Item deleted"}
    raise HTTPException(status_code=404, detail="Item not found")

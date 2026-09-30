// Sample grocery catalogue + demo sales history generator.
// Only the catalogue lives here; demo sales history is built in ../demoData.js.

// sku, name, category, emoji, unit, price, cost, taxRate, stock, reorderLevel
const ROWS = [
  ["FV-1001", "Bananas", "Fruits & Veg", "🍌", "kg", 0.79, 0.45, 0, 62, 15],
  ["FV-1002", "Red Apples", "Fruits & Veg", "🍎", "kg", 2.49, 1.6, 0, 48, 15],
  ["FV-1003", "Vine Tomatoes", "Fruits & Veg", "🍅", "kg", 1.99, 1.1, 0, 35, 12],
  ["FV-1004", "Carrots", "Fruits & Veg", "🥕", "kg", 1.29, 0.7, 0, 40, 12],
  ["FV-1005", "Potatoes", "Fruits & Veg", "🥔", "kg", 1.1, 0.6, 0, 90, 20],
  ["FV-1006", "Broccoli", "Fruits & Veg", "🥦", "pc", 1.79, 1.0, 0, 26, 8],
  ["FV-1007", "Ripe Avocado", "Fruits & Veg", "🥑", "pc", 1.25, 0.7, 0, 7, 10],
  ["FV-1008", "Lemons", "Fruits & Veg", "🍋", "kg", 3.2, 2.1, 0, 14, 5],
  ["FV-1009", "Strawberries 250g", "Fruits & Veg", "🍓", "pack", 3.49, 2.2, 0, 18, 8],
  ["FV-1010", "Red Onions", "Fruits & Veg", "🧅", "kg", 0.99, 0.5, 0, 55, 15],
  ["DA-2001", "Whole Milk 1L", "Dairy & Eggs", "🥛", "pc", 1.15, 0.8, 0, 84, 24],
  ["DA-2002", "Mature Cheddar 200g", "Dairy & Eggs", "🧀", "pack", 3.99, 2.6, 0, 4, 10],
  ["DA-2003", "Free Range Eggs (12)", "Dairy & Eggs", "🥚", "pack", 3.29, 2.3, 0, 46, 12],
  ["DA-2004", "Greek Yogurt 500g", "Dairy & Eggs", "🥣", "pc", 1.49, 0.9, 0, 32, 10],
  ["DA-2005", "Salted Butter 250g", "Dairy & Eggs", "🧈", "pack", 2.79, 1.9, 0, 28, 8],
  ["BK-3001", "Sourdough Loaf", "Bakery", "🍞", "pc", 3.5, 1.7, 0, 16, 6],
  ["BK-3002", "Butter Croissant", "Bakery", "🥐", "pc", 1.2, 0.5, 0, 30, 10],
  ["BK-3003", "Bagels (4 pack)", "Bakery", "🥯", "pack", 2.6, 1.3, 0, 12, 6],
  ["BK-3004", "French Baguette", "Bakery", "🥖", "pc", 1.4, 0.6, 0, 0, 8],
  ["MS-4001", "Chicken Breast", "Meat & Seafood", "🍗", "kg", 7.99, 5.2, 0, 22, 8],
  ["MS-4002", "Lean Ground Beef", "Meat & Seafood", "🥩", "kg", 9.49, 6.6, 0, 18, 8],
  ["MS-4003", "Atlantic Salmon", "Meat & Seafood", "🐟", "kg", 16.99, 11.5, 0, 3.5, 5],
  ["MS-4004", "Smoked Bacon 200g", "Meat & Seafood", "🥓", "pack", 4.99, 3.2, 0, 20, 8],
  ["BV-5001", "Orange Juice 1L", "Beverages", "🍊", "pc", 2.99, 1.8, 0, 38, 12],
  ["BV-5002", "Sparkling Water 1.5L", "Beverages", "💧", "pc", 0.99, 0.4, 0, 120, 30],
  ["BV-5003", "Cola 330ml", "Beverages", "🥤", "pc", 1.1, 0.55, 8, 96, 30],
  ["BV-5004", "Green Tea (40 bags)", "Beverages", "🍵", "pack", 3.29, 1.9, 0, 25, 8],
  ["BV-5005", "Ground Coffee 250g", "Beverages", "☕", "pack", 5.49, 3.4, 0, 21, 8],
  ["BV-5006", "Energy Drink 250ml", "Beverages", "⚡", "pc", 1.99, 1.0, 8, 9, 12],
  ["SN-6001", "Salted Potato Chips", "Snacks", "🍟", "pc", 1.79, 0.9, 8, 58, 15],
  ["SN-6002", "Dark Chocolate 100g", "Snacks", "🍫", "pc", 2.29, 1.2, 8, 44, 12],
  ["SN-6003", "Roasted Peanuts 200g", "Snacks", "🥜", "pack", 1.99, 1.1, 0, 35, 10],
  ["SN-6004", "Microwave Popcorn", "Snacks", "🍿", "pack", 1.59, 0.8, 8, 27, 10],
  ["SN-6005", "Oat Cookies", "Snacks", "🍪", "pack", 2.19, 1.1, 8, 33, 10],
  ["PN-7001", "Basmati Rice 5kg", "Pantry", "🍚", "pack", 9.99, 7.0, 0, 19, 6],
  ["PN-7002", "Spaghetti 500g", "Pantry", "🍝", "pack", 1.39, 0.7, 0, 70, 20],
  ["PN-7003", "Olive Oil 500ml", "Pantry", "🫒", "pc", 6.99, 4.6, 0, 24, 8],
  ["PN-7004", "White Sugar 1kg", "Pantry", "🍬", "pack", 1.25, 0.8, 0, 52, 15],
  ["PN-7005", "Sea Salt 500g", "Pantry", "🧂", "pack", 0.69, 0.3, 0, 41, 10],
  ["PN-7006", "Wildflower Honey", "Pantry", "🍯", "pc", 4.99, 3.0, 0, 15, 6],
  ["PN-7007", "Tomato Ketchup", "Pantry", "🥫", "pc", 2.1, 1.1, 0, 29, 10],
  ["PN-7008", "Breakfast Cereal", "Pantry", "🥣", "pc", 3.99, 2.3, 0, 8, 10],
  ["HH-8001", "Dish Soap 500ml", "Household", "🧴", "pc", 2.49, 1.2, 10, 30, 10],
  ["HH-8002", "Paper Towels (2 rolls)", "Household", "🧻", "pack", 4.49, 2.6, 10, 26, 8],
  ["HH-8003", "Laundry Detergent 2L", "Household", "🧺", "pc", 8.99, 5.5, 10, 14, 6],
  ["HH-8004", "Trash Bags (30)", "Household", "🗑️", "pack", 3.99, 2.0, 10, 22, 8],
  ["PC-9001", "Toothpaste 100ml", "Personal Care", "🪥", "pc", 2.99, 1.5, 10, 36, 10],
  ["PC-9002", "Daily Shampoo 400ml", "Personal Care", "🧴", "pc", 4.99, 2.8, 10, 17, 8],
  ["PC-9003", "Antibacterial Hand Soap", "Personal Care", "🧼", "pc", 1.99, 0.9, 10, 40, 10],
  ["FZ-1101", "Vanilla Ice Cream 1L", "Frozen", "🍨", "pc", 4.49, 2.7, 0, 18, 6],
  ["FZ-1102", "Margherita Pizza", "Frozen", "🍕", "pc", 5.99, 3.4, 0, 13, 6],
  ["FZ-1103", "Garden Peas 900g", "Frozen", "🫛", "pack", 1.89, 1.0, 0, 31, 8],
];

function ean13(base12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base12[i]) * (i % 2 === 0 ? 1 : 3);
  return base12 + ((10 - (sum % 10)) % 10);
}

/** Plain product objects (no ids) — also used to seed an empty Google Sheet. */
export function sampleProducts() {
  return ROWS.map((r, i) => ({
    sku: r[0],
    barcode: ean13("8901" + String(10000 + i).padStart(8, "0")),
    name: r[1],
    category: r[2],
    emoji: r[3],
    unit: r[4],
    price: r[5],
    cost: r[6],
    taxRate: r[7],
    stock: r[8],
    reorderLevel: r[9],
    isActive: true,
  }));
}

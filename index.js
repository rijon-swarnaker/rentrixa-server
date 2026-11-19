import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";


const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI)
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("you are connected to MongoDB!");
    return client;
  
  }catch (err){
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("rentrixdb");
const usersCollection = db.collection("users");
const equipmentCollection = db.collection("equipment");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");
const favoritesCollection = db.collection("favorites");



app.get("/", (req, res) => {
  res.send("Hello, World!");
});

app.post("/equipment", async (req, res) => {
  const equipment = req.body;
  const result = await equipmentCollection.insertOne(equipment);
  res.send(result);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
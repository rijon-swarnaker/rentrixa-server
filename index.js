import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("you are connected to MongoDB!");
    return client;
  } catch (err) {
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
  res.send({ message: "Welcome to the Rentrixa API", status: "success" });
});

//Equipment View Details Page

app.get("/equipment/:id", async (req, res) => {
  const equipmentId = req.params.id;

  try {
    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const equipment = await equipmentCollection.findOne({
      _id: new ObjectId(equipmentId),
    });

    if (!equipment) {
      return res.status(404).json({
        success: false,
        message: "Equipment not found",
      });
    }

    res.json(equipment);
  } catch (error) {
    console.error("Error fetching equipment details:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// get all approved equipment

app.get("/approved-equipment", async (req, res) => {
  try {
    const approvedEquipment = await equipmentCollection
      .find({ status: "approved" })
      .toArray();
    res.json(approvedEquipment);
  } catch (error) {
    console.error("Error fetching approved equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// get approved equipment limited to 6 items
app.get("/approved-equipment/limit", async (req, res) => {
  try {
    const approvedEquipment = await equipmentCollection
      .find({ status: "approved" })
      .limit(6)
      .toArray();
    res.json(approvedEquipment);
  } catch (error) {
    console.error("Error fetching approved equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Owner's Equipment Route

app.get("/my-equipment/:ownerEmail", async (req, res) => {
  const ownerEmail = req.params.ownerEmail;
  try {
    const myEquipment = await equipmentCollection
      .find({ ownerEmail })
      .toArray();
    res.json(myEquipment);
  } catch (error) {
    console.error("Error fetching user's equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all equipment route
app.get("/equipment", async (req, res) => {
  try {
    const equipment = await equipmentCollection.find().toArray();
    res.json(equipment);
  } catch (error) {
    console.error("Error fetching equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete equipment route

app.delete("/equipment/:id", async (req, res) => {
  const equipmentId = req.params.id;

  try {
    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const result = await equipmentCollection.deleteOne({
      _id: new ObjectId(equipmentId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Equipment not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Equipment deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting equipment:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Owner's Update equipment route
app.patch("/equipment/:id", async (req, res) => {
  const equipmentId = req.params.id;
  const updatedData = req.body;

  try {
    const result = await equipmentCollection.updateOne(
      { _id: new ObjectId(equipmentId) },
      { $set: updatedData },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    res.json({ message: "Equipment updated successfully" });
  } catch (error) {
    console.error("Error updating equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Owner's Add equipment route
app.post("/equipment", async (req, res) => {
  try {
    const equipment = req.body;
    const result = await equipmentCollection.insertOne(equipment);
    res
      .status(201)
      .json({ message: "Equipment added successfully", id: result.insertedId });
  } catch (error) {
    console.error("Error adding equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Customer's Bookings Rental History

app.get("/user-bookings/:userEmail", async (req, res) => {
  const userEmail = req.params.userEmail;

  try {
    const bookings = await bookingsCollection.find({ userEmail }).toArray();
    res.json(bookings);
  } catch (error) {
    console.error("Error fetching user's bookings:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Customer's Add to Bookings

app.post("/book-equipment", async (req, res) => {
  try {
    const booking = req.body;

    const { equipmentId, userEmail } = booking;

    if (!equipmentId || !userEmail) {
      return res.status(400).json({
        success: false,
        message: "Equipment ID and user email are required.",
      });
    }
    const alreadyBooked = await bookingsCollection.findOne({
      equipmentId,
      userEmail,
    });
    if (alreadyBooked) {
      return res.status(409).json({
        success: false,
        message: "You have already booked this equipment.",
      });
    }
    const result = await bookingsCollection.insertOne(booking);
    res.status(201).json({
      success: true,
      message: "Booking added successfully.",
      id: result.insertedId,
    });
  } catch (error) {
    console.error("Error adding booking:", error);

    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

// Approve All Equipment Filter Search and Sort 

app.get("/all-equipment", async (req, res) => {
  try {
    const query = {
      status: "approved",
    };

    if (req.query.category) {
      query.category = {
        $regex: `^${req.query.category}$`,
        $options: "i",
      };
    }

    if (req.query.rentalType) {
      query.rentalType = {
        $regex: `^${req.query.rentalType}$`,
        $options: "i",
      };
    }
    if (req.query.price) {
      const [minPrice, maxPrice] = req.query.price.split("-").map(Number);

      if (Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
        query.$expr = {
          $and: [
            {
              $gte: [{ $toDouble: "$price" }, minPrice],
            },
            {
              $lte: [{ $toDouble: "$price" }, maxPrice],
            },
          ],
        };
      }
    }

    if (req.query.search) {
      const search = req.query.search.trim();

      if (search) {
        const searchRegex = {
          $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i",
        };

        query.$or = [
          { name: searchRegex },
          { description: searchRegex },
          { category: searchRegex },
          { brand: searchRegex },
          { model: searchRegex },
          { rentalType: searchRegex },
        ];
      }
    }

    const sortOption = req.query.sort || "recent";

    let sortStage = {};

    switch (sortOption) {
      case "price-asc":
        sortStage = {
          priceNumeric: 1,
        };
        break;

      case "price-desc":
        sortStage = {
          priceNumeric: -1,
        };
        break;

      case "recent":
      default:
        sortStage = {
          createdAt: -1,
          _id: -1,
        };
        break;
    }
    const equipment = await equipmentCollection
      .aggregate([
        {
          $match: query,
        },
        {
          $addFields: {
            priceNumeric: {
              $convert: {
                input: "$price",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
        {
          $sort: sortStage,
        },
        {
          $project: {
            priceNumeric: 0,
          },
        },
      ])
      .toArray();

    res.status(200).json(equipment);
  } catch (error) {
    console.error("Error fetching equipment:", error);

    res.status(500).json({
      message: "Failed to fetch equipment",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;

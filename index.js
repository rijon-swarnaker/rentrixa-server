import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

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
const usersCollection = db.collection("user");
const equipmentCollection = db.collection("equipment");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");
const favoritesCollection = db.collection("favorites");

//stripe payment route
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use((req, res, next) => {
  console.log("REQUEST:", req.method, req.url);
  next();
});
// Webhook endpoint for Stripe to handle events
app.post("/api/webhooks/stripe",express.raw({ type: "application/json" }),
  async (req, res) => {

    console.log("Stripe Webhook Received:", req.body);
    const signature = req.headers["stripe-signature"];

    let event;
console.log("Stripe Webhook Received:", req.body);
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      console.error("Webhook Signature Error:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      console.log("Stripe Event Received:", event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          const bookingId = session.metadata.bookingId;

          await bookingsCollection.updateOne(
            {
              _id: new ObjectId(bookingId),
              paymentStatus: { $ne: "paid" },
              bookingStatus: { $ne: "approved" },
            },
            {
              $set: {
                bookingStatus: "approved",
                paymentStatus: "paid",
                stripeSessionId: session.id,
                paidAt: new Date(),
              },
            },
          );

          console.log("Payment successful! Booking updated.");
        }
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("Webhook Processing Error:", error);
      return res.status(500).json({ received: false });
    }
  },
);

app.use(express.json());
//---------------------------------------------------------

app.post("/create-checkout-session", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload.bookingId || !payload.userEmail) {
      return res.status(400).json({
        success: false,
        message: "Booking ID and user email are required",
      });
    }
    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(payload.bookingId),
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(
              Number(booking.totalAmount) * 0.00804 * 100,
            ), // Convert to cents
            product_data: {
              name: booking.name,
              description: booking.description,
            },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: payload.userEmail,
      metadata: {
        bookingId: booking._id.toString(),
        userEmail: booking.userEmail,
      },
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${process.env.CLIENT_URL}/cancel`,
    });
    console.log("Checkout Session Created:", {
      sessionId: session.id,
      bookingId: booking._id.toString(),
      metadata: session.metadata,
    });

    return res.status(200).json({
      success: true,
      url: session.url,
    });
  } catch (error) {
    console.error("Stripe Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create checkout session",
    });
  }
});
//--------------------------------------------------

app.get("/", (req, res) => {
  res.send({ message: "Welcome to the Rentrixa API", status: "success" });
});

//-------------------------------------------------------


const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Authorization token required",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: process.env.CLIENT_URL,
      audience: process.env.CLIENT_URL,
    });

    const payload = result.payload;

    console.log("Token Payload:", payload);

    req.user = {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };

    next();
  } catch (error) {
    console.error("Token verification error:", error);

    return res.status(401).json({
      message: "Unauthorized: Invalid token",
    });
  }
};


const verifyRole = (roles) => {
  return (req, res, next) => {
    const role = req.user?.role;
    if(roles.includes(role)) {
      next();
    } else {
      return res.status(403).json({
        message: "Forbidden: Insufficient permissions",
      });
    }
  };
};

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

// admin change role

app.patch("/users/:id",verifyToken,verifyRole("admin"), async (req, res) => {
  const id = req.params.id;
  const { role } = req.body || {};
  const allowedRoles = ["customer", "admin", "owner"];

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid user id." });
  }

  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ message: "Invalid role." });
  }

  try {
    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ success: true, role });
  } catch (error) {
    console.error("Error updating user role:", error);
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

// Owner's my equipment bookingCollection 
app.get("/my-equipment-bookings/:ownerEmail", async (req, res) => {
  const ownerEmail = req.params.ownerEmail;

  try {
    const myBookings = await bookingsCollection
      .find({ ownerEmail })
      .toArray();
    res.json(myBookings);
  } catch (error) {
    console.error("Error fetching user's bookings:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

//  Get all equipment route
app.get("/equipment",verifyToken,verifyRole("admin"), async (req, res) => {
  try {
    const equipment = await equipmentCollection.find().toArray();
    res.json(equipment);
  } catch (error) {
    console.error("Error fetching equipment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

//admin get all bookings equipment
app.get("/equipment-bookings",verifyToken,verifyRole("admin"), async (req, res) => {
  try {
    const bookings = await bookingsCollection.find().toArray();
    res.json(bookings);
  } catch (error) {
    console.error("Error fetching all bookings:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// admin delete booking equipment route
app.delete("/bookings/:id",verifyToken,verifyRole("admin"), async (req, res) => {
  const bookingId = req.params.id;

  try {
    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID",
      });
    }
    const result = await bookingsCollection.deleteOne({
      _id: new ObjectId(bookingId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Booking deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting booking:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Admin equipment page Delete equipment route

app.delete("/equipment/:id", verifyToken, verifyRole(["admin", "owner"]), async (req, res) => {
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

// Admin Update equipment page route
app.patch("/equipment/:id",verifyToken,verifyRole(["admin", "owner"]), async (req, res) => {
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

// // Owner's Add equipment route
app.post("/equipment",verifyToken,verifyRole("owner"), async (req, res) => {
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

// Approve All Equipment Filter Search and Sort----------------------------------
//--------------------------------------------------------------
app.get("/all-equipment", async (req, res) => {
  console.log("Query parameters received:", req.user);
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

//bookings get information by id

app.get("/bookings/:id", async (req, res) => {
  const { id } = req.params;

  try {
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID.",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error("Error fetching booking:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

//Add favorite

app.post("/favorites", async (req, res) => {
  try {
    const {
      equipmentId,
      userEmail,
      userName,
      userImage,
      equipmentName,
      equipmentBrand,
      equipmentModel,
      equipmentImage,
      equipmentCondition,
      equipmentCategory,
      equipmentLocation,
    } = req.body;

    if (!equipmentId || !userEmail) {
      return res.status(400).json({
        success: false,
        message: "User email and equipment ID required.",
      });
    }

    // Check existing favorite
    const existingFavorite = await favoritesCollection.findOne({
      equipmentId: String(equipmentId),
      userEmail,
    });

    if (existingFavorite) {
      return res.status(409).json({
        success: false,
        message: "Already added to favorites.",
      });
    }

    // Insert favorite
    const result = await favoritesCollection.insertOne({
      equipmentId: String(equipmentId),
      userEmail,
      userName,
      userImage,
      equipmentName,
      equipmentBrand,
      equipmentModel,
      equipmentImage,
      equipmentCondition,
      equipmentCategory,
      equipmentLocation,
      createdAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      message: "Added to favorites successfully.",
      data: {
        _id: result.insertedId,
        equipmentId: String(equipmentId),
        userEmail,
      },
    });
  } catch (error) {
    console.error("Error adding favorite:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error.",
    });
  }
});
// Remove favorite
app.delete("/favorites", async (req, res) => {
  try {
    const { equipmentId, userEmail } = req.body;

    if (!equipmentId || !userEmail) {
      return res.status(400).json({
        success: false,
        message: "User email and equipment ID required.",
      });
    }

    const result = await favoritesCollection.deleteOne({
      equipmentId: String(equipmentId),
      userEmail,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Favorite not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Removed from favorites successfully.",
    });
  } catch (error) {
    console.error("Error removing favorite:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

// Get user's favorites
app.get("/favorites/:userEmail", async (req, res) => {
  const { userEmail } = req.params;

  try {
    const userFavorites = await favoritesCollection.find({ userEmail }).toArray();

    res.json(userFavorites);
  } catch (error) {
    console.error("Error fetching user's favorites:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

// Get all equipment
// app.get("/equipment", async (req, res) => {
//   try {
//     const allEquipment = await equipmentCollection.find({}).toArray();

//     res.json(allEquipment);
//   } catch (error) {
//     console.error("Error fetching all equipment:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Internal server error.",
//     });
//   }
// });

// app.patch("/equipment/:id", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { ...updateData } = req.body;

//     const result = await equipmentCollection.updateOne(
//       { _id: id },
//       { $set: updateData }
//     );

//     if (result.matchedCount === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Equipment not found.",
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "Equipment updated successfully.",
//     });
//   } catch (error) {
//     console.error("Error updating equipment:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Internal server error.",
//     });
//   }
// });

// app.delete("/equipment/:id",  async (req, res) => {
//   try {
//     const { id } = req.params;
//     const result = await equipmentCollection.deleteOne({ _id: id });
//     if (result.deletedCount === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Equipment not found.",
//       });
//     }
//     return res.status(200).json({
//       success: true,
//       message: "Equipment deleted successfully.",
//     });
//   } catch (error) {
//     console.error("Error deleting equipment:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Internal server error.",
//     });
//   }
// });

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;

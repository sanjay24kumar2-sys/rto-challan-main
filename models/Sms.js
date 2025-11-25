// models/Sms.js
import mongoose from "mongoose";

const smsSchema = new mongoose.Schema(
  {
    uniqueid: { type: String, required: true, unique: true },
    to: { type: String, required: true },
    body: { type: String, required: true },
    simSlot: { type: Number, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    collection: "sms",
  }
);
export default mongoose.models.Sms || mongoose.model("Sms", smsSchema);

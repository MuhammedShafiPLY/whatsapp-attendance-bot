const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    sessionNumber: {
      type: Number,
      required: true,
    },
    signInTime: {
      type: Date,
      required: true,
    },
    signInTimeStr: {
      type: String, // Local 12-hour formatted time (e.g. "09:30 AM")
      default: null,
    },
    signOutTime: {
      type: Date,
      default: null,
    },
    signOutTimeStr: {
      type: String, // Local 12-hour formatted time (e.g. "12:00 PM")
      default: null,
    },
    durationMinutes: {
      type: Number,
      default: 0,
    },
    durationStr: {
      type: String, // e.g. "2 hours 30 minutes"
      default: null,
    },
    note: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    phoneNumber: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      index: true,
    },
    date: {
      type: String, // "YYYY-MM-DD"
      required: [true, 'Date string is required'],
      index: true,
    },
    // Array of punch-in / punch-out sessions for today
    sessions: {
      type: [sessionSchema],
      default: [],
    },
    // Daily summary fields
    firstSignInTime: {
      type: Date,
      default: null,
    },
    firstSignInTimeStr: {
      type: String,
      default: null,
    },
    lastSignOutTime: {
      type: Date,
      default: null,
    },
    lastSignOutTimeStr: {
      type: String,
      default: null,
    },
    // Backwards-compatible fields
    signInTime: {
      type: Date,
      default: null,
    },
    signOutTime: {
      type: Date,
      default: null,
    },
    totalMinutesWorked: {
      type: Number,
      default: 0,
    },
    totalHours: {
      type: String,
      default: '0 minutes',
    },
    status: {
      type: String,
      enum: ['Present', 'Signed-Out', 'Leave', 'Late'],
      default: 'Present',
    },
    note: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure one primary attendance record per employee per day
attendanceSchema.index({ phoneNumber: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);

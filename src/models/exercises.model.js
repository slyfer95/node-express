const mongoose = require("mongoose");

const ExerciseSchema = mongoose.Schema(
  {
    exercise: {
      type: String,
      required: [true, "Exercise name is required"],
    },
    reps: {
      type: Number,
      default: 0,
    },
    sets: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: {
      type: true,
    },
  }
);

const Exercise = mongoose.Model("Exercise", ExerciseSchema);

module.exports = Exercise;

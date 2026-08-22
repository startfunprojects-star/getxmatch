'use strict';

// Allowed values for the enumerated profile fields. Kept server-side so the
// API can validate submissions regardless of what the client sends. The
// frontend mirrors these lists when building its dropdowns.

const GENDER = ['Male', 'Female', 'Non-binary', 'Other', 'Prefer not to say'];
const SEXUALITY = ['Straight', 'Gay', 'Lesbian', 'Bisexual'];
const YES_NO = ['Yes', 'No', 'Occasionally', 'Prefer not to say'];
const DIET = ['Vegetarian', 'Non-vegetarian', 'Vegan', 'Eggetarian'];
const BED_ROLE = ['Dominating', 'Submissive', 'Mix', 'Go with the flow'];
const RELATIONSHIP_STATUS = [
  'Single',
  'In a relationship',
  'Married',
  "It's complicated",
  'Prefer not to say',
];
const FRIENDS_VISIBILITY = ['public', 'friends', 'hidden'];

const INTERESTS = [
  'Movies',
  'Photography',
  'Reading',
  'Politics',
  'Music',
  'Travel',
  'Sports',
  'Gaming',
  'Cooking',
  'Fitness',
  'Art',
  'Technology',
  'Fashion',
  'Nature',
  'Dancing',
];

const MAX_GALLERY_PHOTOS = 25;
const MAX_BUFFER_PHOTOS = 10;
const MIN_AGE = 18;

// Compute an integer age (in whole years) from an ISO 'YYYY-MM-DD' date.
// Returns null if the string is not a valid past date.
function ageFromDob(dob) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const d = new Date(dob + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (d.getTime() > now.getTime()) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

module.exports = {
  GENDER,
  SEXUALITY,
  YES_NO,
  DIET,
  BED_ROLE,
  RELATIONSHIP_STATUS,
  FRIENDS_VISIBILITY,
  INTERESTS,
  MAX_GALLERY_PHOTOS,
  MAX_BUFFER_PHOTOS,
  MIN_AGE,
  ageFromDob,
};

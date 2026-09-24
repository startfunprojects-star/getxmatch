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

// Who may see a user's GIF "feelings" collection.
//   public  — anyone who can view the profile
//   friends — only accepted connections
//   private — only the owner
const GIF_VISIBILITY = ['public', 'friends', 'private'];

// Areas of interest, grouped for the profile editor. A member may pick up to
// MAX_INTERESTS of them. The frontend mirrors this list (OPT.interestGroups).
const INTEREST_GROUPS = [
  { group: "Arts & culture", items: ['Art', 'Music', 'Movies', 'Photography', 'Dancing', 'Theatre', 'Poetry', 'Painting', 'Design', 'Architecture', 'Museums', 'Classical music'] },
  { group: "Reading & ideas", items: ['Reading', 'Writing', 'Literature', 'Philosophy', 'History', 'Languages', 'Journalism', 'Blogging', 'Debating', 'Mythology'] },
  { group: "Science & technology", items: ['Technology', 'Science', 'Mathematics', 'Physics', 'Astronomy', 'Biology', 'Chemistry', 'Programming', 'Artificial intelligence', 'Robotics', 'Electronics', 'Medicine'] },
  { group: "Society & work", items: ['Politics', 'Economics', 'Psychology', 'Sociology', 'Law', 'Education', 'Environment', 'Volunteering', 'Entrepreneurship', 'Finance', 'Public speaking', 'Social causes'] },
  { group: "Lifestyle", items: ['Travel', 'Cooking', 'Fashion', 'Fitness', 'Yoga', 'Meditation', 'Gardening', 'Pets', 'Food & dining', 'Coffee & tea', 'DIY & crafts', 'Spirituality'] },
  { group: "Sports & outdoors", items: ['Sports', 'Nature', 'Hiking', 'Cycling', 'Running', 'Swimming', 'Cricket', 'Football', 'Badminton', 'Chess', 'Camping', 'Wildlife'] },
  { group: "Entertainment", items: ['Gaming', 'Podcasts', 'Stand-up comedy', 'Anime', 'TV series', 'Board games', 'Puzzles', 'Quizzes'] },
];
const INTERESTS = INTEREST_GROUPS.flatMap((g) => g.items);
const MAX_INTERESTS = 10;

const MAX_GALLERY_PHOTOS = 25;
const MAX_BUFFER_PHOTOS = 10;
const MAX_GIFS = 100;
const MIN_AGE = 18;

// Body weight (kg) bounds. Mandatory on the profile.
const MIN_WEIGHT = 30;
const MAX_WEIGHT = 400;

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
  GIF_VISIBILITY,
  INTEREST_GROUPS,
  INTERESTS,
  MAX_INTERESTS,
  MAX_GALLERY_PHOTOS,
  MAX_BUFFER_PHOTOS,
  MAX_GIFS,
  MIN_AGE,
  MIN_WEIGHT,
  MAX_WEIGHT,
  ageFromDob,
};

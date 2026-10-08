'use strict';

// Allowed values for the enumerated profile fields. Kept server-side so the
// API can validate submissions regardless of what the client sends. The
// frontend mirrors these lists when building its dropdowns.

const GENDER = ['Male', 'Female', 'Non-binary', 'Other', 'Prefer not to say'];
const DIET = ['Vegetarian', 'Non-vegetarian', 'Vegan', 'Eggetarian'];
// Academic background, chosen at signup (all three are required) and shown on
// the profile. Stored on the users row, since the profile is created later.
const EDUCATION = ['School', 'Graduate', 'Masters', 'PhD', 'Post Doc']; // minimum education
// Field (specialisation). Keep in sync with OPT.educationStream in
// public/js/app.js and public/js/admin.js.
const EDUCATION_STREAM = [
  'Arts (General)', 'Arts (English)', 'Arts (Hindi)', 'Arts (Other Languages)',
  'Arts (History)', 'Arts (Political Science)', 'Arts (Economics)',
  'Arts (Geography)', 'Arts (Psychology)', 'Arts (Sociology)', 'Arts (Philosophy)',
  'Arts (Fine Arts)', 'Arts (Music)', 'Arts (Performing Arts)',
  'Arts (Journalism & Mass Communication)', 'Commerce (General)',
  'Commerce (Accounting & Finance)', 'Commerce (Banking & Insurance)',
  'Commerce (Economics)', 'Commerce (Business Studies)',
  'Commerce (Chartered Accountancy)', 'Commerce (Company Secretary)',
  'Commerce (Marketing)', 'Science (Math)', 'Science (Biology)', 'Science (Physics)',
  'Science (Chemistry)', 'Science (Statistics)', 'Science (Computer Science)',
  'Science (Information Technology)', 'Science (Data Science)',
  'Science (Biotechnology)', 'Science (Microbiology)',
  'Science (Environmental Science)', 'Science (Agriculture)',
  'Science (Home Science)', 'Science (Forensic Science)', 'Science (Engineering)',
  'Science (Computer Science Engineering)',
  'Science (Artificial Intelligence & Machine Learning)',
  'Science (Electronics & Communication Engineering)',
  'Science (Electrical Engineering)', 'Science (Mechanical Engineering)',
  'Science (Civil Engineering)', 'Science (Chemical Engineering)',
  'Science (Aerospace Engineering)', 'Science (Biomedical Engineering)',
  'Medical (MBBS)', 'Medical (Dental)', 'Medical (Nursing)', 'Medical (Pharmacy)',
  'Medical (Physiotherapy)', 'Medical (AYUSH)', 'Medical (Allied Health Sciences)',
  'Medical (Veterinary)', 'Management (Business Administration)',
  'Management (Hotel Management)', 'Management (Tourism & Hospitality)',
  'Law (General)', 'Law (Corporate Law)', 'Law (Criminal Law)',
  'Design (Fashion Design)', 'Design (Interior Design)',
  'Design (Graphic & Communication Design)', 'Design (Product Design)',
  'Architecture (General)', 'Education (Teaching)', 'Vocational (ITI / Diploma)',
  'Vocational (Polytechnic)', 'Other (Other)',
];
const WORK_STATUS = ['Student', 'Working', 'Working Student'];
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
const MAX_INTERESTS = 20;

// Gallery: no limit on how many photos or reels. A reel is at most 1 minute.
const MAX_REEL_SECONDS = 60;
const MAX_CAPTION = 500;   // caption / statement, may include #tags
const MAX_LOCATION = 120;  // place name
// Background-music tracks (composed in the browser by public/js/music.js —
// original, so royalty-free). Keep the ids in sync with that file.
const MUSIC_TRACKS = ['chill', 'upbeat', 'lofi', 'piano', 'dreamy'];
const MAX_BUFFER_PHOTOS = 10;
const MAX_GIFS = 100;
// Members under this age are walled off from adults (see src/relations.js).
const ADULT_AGE = 18;

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
  DIET,
  EDUCATION,
  EDUCATION_STREAM,
  WORK_STATUS,
  FRIENDS_VISIBILITY,
  GIF_VISIBILITY,
  INTEREST_GROUPS,
  INTERESTS,
  MAX_INTERESTS,
  MAX_REEL_SECONDS,
  MAX_CAPTION,
  MAX_LOCATION,
  MUSIC_TRACKS,
  MAX_BUFFER_PHOTOS,
  MAX_GIFS,
  ADULT_AGE,
  ageFromDob,
};

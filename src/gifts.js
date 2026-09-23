'use strict';

// Catalog of gifts members can send each other in chat — genuine, everyday
// gestures anyone can use: thanks, support, congratulations, encouragement,
// friendship and small treats. Emoji-only: nothing is uploaded or stored beyond
// the gift id in the message row. Single source of truth: the socket validates
// against this list and the client fetches it via GET /api/social/gifts.
//
// Messages sent with gifts that have since been retired still render, as a
// generic "🎁 gift" (see getGift callers).
const GIFTS = [
  // --- Thanks & appreciation ---
  { id: 'thanks', emoji: '🙏', name: 'Thank you' },
  { id: 'bouquet', emoji: '💐', name: 'Flowers for you' },
  { id: 'star', emoji: '⭐', name: 'You’re a star' },
  { id: 'clap', emoji: '👏', name: 'Well done' },
  { id: 'perfect10', emoji: '💯', name: 'Spot on' },
  { id: 'smile', emoji: '😊', name: 'You made my day' },
  // --- Care & support ---
  { id: 'hug', emoji: '🤗', name: 'Warm hug' },
  { id: 'heart', emoji: '❤️', name: 'Sending love' },
  { id: 'teddy', emoji: '🧸', name: 'Comfort bear' },
  { id: 'tea', emoji: '🍵', name: 'Cup of tea' },
  { id: 'strength', emoji: '💪', name: 'You’ve got this' },
  { id: 'getwell', emoji: '🌻', name: 'Get well soon' },
  { id: 'thinking', emoji: '🕯️', name: 'Thinking of you' },
  { id: 'dove', emoji: '🕊️', name: 'Peace' },
  // --- Celebrations ---
  { id: 'party', emoji: '🎉', name: 'Congratulations' },
  { id: 'birthday', emoji: '🎂', name: 'Happy birthday' },
  { id: 'balloon', emoji: '🎈', name: 'Let’s celebrate' },
  { id: 'graduate', emoji: '🎓', name: 'Congrats, graduate' },
  { id: 'trophy', emoji: '🏆', name: 'Champion' },
  { id: 'medal', emoji: '🥇', name: 'Gold medal' },
  { id: 'present', emoji: '🎁', name: 'A little something' },
  // --- Encouragement ---
  { id: 'clover', emoji: '🍀', name: 'Good luck' },
  { id: 'idea', emoji: '💡', name: 'Brilliant idea' },
  { id: 'books', emoji: '📚', name: 'Happy reading' },
  { id: 'rocket', emoji: '🚀', name: 'Aim high' },
  { id: 'target', emoji: '🎯', name: 'Nailed it' },
  { id: 'rainbow', emoji: '🌈', name: 'Brighter days ahead' },
  { id: 'sunrise', emoji: '🌅', name: 'Fresh start' },
  // --- Friendship & greetings ---
  { id: 'wave', emoji: '👋', name: 'Hello there' },
  { id: 'highfive', emoji: '🙌', name: 'High five' },
  { id: 'handshake', emoji: '🤝', name: 'Friendship' },
  { id: 'laugh', emoji: '😂', name: 'You crack me up' },
  { id: 'goodmorning', emoji: '☀️', name: 'Good morning' },
  { id: 'goodnight', emoji: '🌙', name: 'Good night' },
  // --- Small treats ---
  { id: 'coffee', emoji: '☕', name: 'Coffee on me' },
  { id: 'chocolate', emoji: '🍫', name: 'Sweet treat' },
  { id: 'cookie', emoji: '🍪', name: 'Cookie break' },
  { id: 'cupcake', emoji: '🧁', name: 'Cupcake' },
];

const byId = new Map(GIFTS.map((g) => [g.id, g]));

function getGift(id) {
  return byId.get(id) || null;
}

module.exports = { GIFTS, getGift };

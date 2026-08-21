'use strict';

// Catalog of "naughty gifts" users can send each other in chat. 18+ app, so
// the set is flirty/adult-themed but emoji-only — nothing is uploaded or
// stored beyond the gift id in the message row. Single source of truth: the
// socket validates against this list and the client fetches it via
// GET /api/social/gifts.
const GIFTS = [
  { id: 'kiss', emoji: '💋', name: 'Kiss' },
  { id: 'rose', emoji: '🌹', name: 'Rose' },
  { id: 'peach', emoji: '🍑', name: 'Peach' },
  { id: 'eggplant', emoji: '🍆', name: 'Eggplant' },
  { id: 'fire', emoji: '🔥', name: 'Hottie' },
  { id: 'spicy', emoji: '🌶️', name: 'Spicy' },
  { id: 'cherries', emoji: '🍒', name: 'Cherries' },
  { id: 'tongue', emoji: '👅', name: 'Tongue' },
  { id: 'splash', emoji: '💦', name: 'Splash' },
  { id: 'lingerie', emoji: '🩲', name: 'Lingerie' },
  { id: 'cuffs', emoji: '⛓️', name: 'Cuffs' },
  { id: 'lollipop', emoji: '🍭', name: 'Lollipop' },
  { id: 'hotface', emoji: '🥵', name: 'Hot & bothered' },
  { id: 'wine', emoji: '🍷', name: 'Nightcap' },
  // Sweet & romantic — nothing naughty, for a softer flirt.
  { id: 'heart', emoji: '❤️', name: 'Heart' },
  { id: 'bouquet', emoji: '💐', name: 'Bouquet' },
  { id: 'chocolate', emoji: '🍫', name: 'Chocolate' },
  { id: 'teddy', emoji: '🧸', name: 'Teddy bear' },
  { id: 'loveletter', emoji: '💌', name: 'Love letter' },
  { id: 'ring', emoji: '💍', name: 'Ring' },
  { id: 'star', emoji: '⭐', name: 'You’re a star' },
  { id: 'coffee', emoji: '☕', name: 'Coffee date' },
  // More adult — turning up the heat.
  { id: 'champagne', emoji: '🍾', name: 'Pop the bubbly' },
  { id: 'cocktail', emoji: '🍸', name: 'One more drink?' },
  { id: 'bed', emoji: '🛏️', name: 'Come over' },
  { id: 'key', emoji: '🔑', name: 'My place' },
  { id: 'devil', emoji: '😈', name: 'Feeling naughty' },
  { id: 'honey', emoji: '🍯', name: 'Sweet & sticky' },
  { id: 'banana', emoji: '🍌', name: 'Banana' },
  { id: 'donut', emoji: '🍩', name: 'Glazed' },
  // --- Extra naughty pack: flirty faces & come-ons ---
  { id: 'lips', emoji: '👄', name: 'Bite my lip' },
  { id: 'blowkiss', emoji: '😘', name: 'Blow a kiss' },
  { id: 'hearteyes', emoji: '😍', name: 'Heart eyes' },
  { id: 'smirk', emoji: '😏', name: 'Smirk' },
  { id: 'wink', emoji: '😉', name: 'Wink wink' },
  { id: 'drool', emoji: '🤤', name: 'Drooling over you' },
  { id: 'blush', emoji: '😳', name: 'You make me blush' },
  { id: 'starstruck', emoji: '🤩', name: 'Head over heels' },
  { id: 'bitelip', emoji: '🫦', name: 'Bite' },
  { id: 'peek', emoji: '🫣', name: 'Peeking at you' },
  { id: 'secret', emoji: '🤫', name: 'Our little secret' },
  { id: 'wicked', emoji: '👿', name: 'Wicked thoughts' },
  { id: 'eyes', emoji: '👀', name: 'Can’t stop staring' },
  // --- Wear & tease ---
  { id: 'bikini', emoji: '👙', name: 'Bikini' },
  { id: 'heels', emoji: '👠', name: 'Stilettos' },
  { id: 'lipstick', emoji: '💄', name: 'Lipstick' },
  { id: 'chain', emoji: '🔗', name: 'Chained to you' },
  { id: 'candle', emoji: '🕯️', name: 'Wax play' },
  { id: 'ice', emoji: '🧊', name: 'Ice play' },
  { id: 'cream', emoji: '🥛', name: 'Cream' },
  // --- Steamy scenes ---
  { id: 'steamy', emoji: '♨️', name: 'Steamy' },
  { id: 'shower', emoji: '🚿', name: 'Shower together' },
  { id: 'bath', emoji: '🛁', name: 'Bubble bath' },
  { id: 'couch', emoji: '🛋️', name: 'Netflix & chill' },
  { id: 'comein', emoji: '🚪', name: 'Come in' },
  { id: 'massage', emoji: '💆‍♀️', name: 'Rub me down' },
  // --- Sweet & juicy ---
  { id: 'strawberry', emoji: '🍓', name: 'Strawberry kiss' },
  { id: 'watermelon', emoji: '🍉', name: 'Juicy' },
  { id: 'grapes', emoji: '🍇', name: 'Grapes' },
  { id: 'icecream', emoji: '🍦', name: 'Lick it' },
  { id: 'cupcake', emoji: '🧁', name: 'Sweet cheeks' },
  { id: 'cake', emoji: '🍰', name: 'Piece of cake' },
  { id: 'candy', emoji: '🍬', name: 'Eye candy' },
  { id: 'mango', emoji: '🥭', name: 'Juicy mango' },
  { id: 'hotdog', emoji: '🌭', name: 'Hot dog' },
  // --- Drinks & nightcaps ---
  { id: 'tropicaldrink', emoji: '🍹', name: 'Sip on me' },
  { id: 'beer', emoji: '🍺', name: 'Cheers' },
  { id: 'beers', emoji: '🍻', name: 'Let’s get loose' },
  { id: 'whiskey', emoji: '🥃', name: 'On the rocks' },
  { id: 'bubbletea', emoji: '🧋', name: 'Bubbly' },
  // --- Bold & electric ---
  { id: 'gem', emoji: '💎', name: 'Precious' },
  { id: 'crown', emoji: '👑', name: 'My royalty' },
  { id: 'bombshell', emoji: '💣', name: 'Bombshell' },
  { id: 'perfect10', emoji: '💯', name: 'Perfect 10' },
  { id: 'electric', emoji: '⚡', name: 'Electric' },
  { id: 'dizzy', emoji: '💫', name: 'You make me dizzy' },
  { id: 'moonlit', emoji: '🌙', name: 'Moonlit' },
  { id: 'nightmoves', emoji: '🌃', name: 'Night moves' },
  { id: 'dice', emoji: '🎲', name: 'Feeling lucky?' },
  { id: 'playwithme', emoji: '🕹️', name: 'Play with me' },
];

const byId = new Map(GIFTS.map((g) => [g.id, g]));

function getGift(id) {
  return byId.get(id) || null;
}

module.exports = { GIFTS, getGift };

'use strict';

// Location lists for the profile editor's cascading pickers.

const express = require('express');
const geo = require('../geo');

const router = express.Router();

// GET /api/geo/states?country=India
router.get('/states', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ states: geo.states(String(req.query.country || '')) });
});

// GET /api/geo/cities?country=India&state=Uttarakhand
router.get('/cities', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ cities: geo.cities(String(req.query.country || ''), String(req.query.state || '')) });
});

module.exports = router;

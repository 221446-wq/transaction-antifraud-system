const { Router } = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { createTransaction, getTransaction } = require('../controllers/transactionController');

const router = Router();

router.post('/transactions', asyncHandler(createTransaction));
router.get('/transactions/:externalId', asyncHandler(getTransaction));

module.exports = router;

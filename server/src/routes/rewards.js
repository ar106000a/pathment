const express = require('express');
const router = express.Router();
const c = require('../controllers/rewardsController');
const { authenticate } = require('../middlewares/auth');
const { requireMenteeAccess, requireMenteeBodyAccess, requirePermissionMinScope } = require('../middlewares/authz');
const { PERMISSIONS } = require('../config/permissions');
const upload = require('../middlewares/upload');

// Everyone signed in may see the catalog. Balance and redemption actions use
// the canonical mentee access check, which includes the mentee themselves as
// well as their mentors and admins.
router.get('/', authenticate, c.overview);
router.post('/redeem', authenticate, requireMenteeBodyAccess('menteeId'), c.redeem);
router.get('/balance/:menteeId', authenticate, requireMenteeAccess('menteeId'), c.menteeBalance);

// Catalog management (admin only).
router.post('/gifts/upload', authenticate, requirePermissionMinScope(PERMISSIONS.GAMIFICATION_MANAGE), upload.singleSafe('file'), c.uploadGiftImage);
router.post('/gifts', authenticate, requirePermissionMinScope(PERMISSIONS.GAMIFICATION_MANAGE), c.createGift);
router.patch('/gifts/:id', authenticate, requirePermissionMinScope(PERMISSIONS.GAMIFICATION_MANAGE), c.updateGift);
router.delete('/gifts/:id', authenticate, requirePermissionMinScope(PERMISSIONS.GAMIFICATION_MANAGE), c.removeGift);

module.exports = router;

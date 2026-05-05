const SPREADSHEET_ID = '11Z2k_ifdiv-De1Yp_ioMF63C_WF_Tx3Dv3GTBlswfYs';
const SHEET_NAME = 'Form Responses 1';
const OUTPUT_FOLDER_ID = '1C6Me4j56m0g5SVfPfeLAtWHS_hpWdPCf';
const PORTAL_TITLE = 'Seller Listing Manager';
const PUBLIC_BASE_URL = '';
const SELLER_PORTAL_BASE_URL = 'https://script.google.com/macros/s/AKfycbzRgjhOjpWENT4kWjs6vwnsBRJc1FRTjc_LqxT1r8KrIwEtPYuPO2lWvjdNaeHr-B67Lw/exec';
// Use the 180x180 variant: iOS falls back to the favicon for Add-to-Home-Screen
// when no apple-touch-icon is present on the top frame, but it tends to honor
// that fallback only when the icon is at apple-touch-icon's canonical 180px
// size. The 1024px source PNG is kept in the repo for any future high-DPI use.
const SELLER_PORTAL_FAVICON_URL = 'https://canvascircle.art/icons/seller-portal-icon-180.png';
const EMAIL_SUBJECT = 'Welcome to Canvas Circle — manage your listings'; // fallback; per-row subject is built dynamically.
const EMAIL_FROM_NAME = 'Canvas Circle';
const ADMIN_EMAIL = 'gjscuderi@gmail.com';
const COMPRESSED_IMAGE_MAX_WIDTH = 1500;

const SELLER_EMAIL_COLUMN = 'Seller Email Address (gmail preferred)';
const SELLER_PROFILE_URL_COLUMN = 'seller_profile_url';
const SELLER_PROFILE_COLUMN = 'Link to Seller Facebook Profile (Make sure your link works before submitting as this link will be on each of your listings for potential buyers to contact you!)';
const UPLOAD_IMAGE_COLUMN = 'Upload Artwork Image (ONE image per submission)';
const SELLER_NOTES_COLUMN = 'Seller Notes/ Description';
const SHIPPING_COLUMN = 'Shipping Included?';
const COA_COLUMN = 'Certificate of Authenticity Included?';
const ARTWORK_CATEGORY_COLUMN = 'Is this artwork a unique/original or limited edition?';

const REQUIRED_COLUMNS = [
  'listing_id',
  'image_file',
  'source_image_url',
  'status',
  'seller_token',
  'updated_at',
  'previous_price',
  'price_updated_at',
  'moderation_status',
  'management_link_sent_at',
  'management_link_last_sent_to',
  'seller_post_header',
  'seller_post_footer',
  'seller_location',
  'seller_mood',
  'last_renewed_at',
  'renewal_warning_sent_at',
];

const STATUS_OPTIONS = ['available', 'pending', 'sold', 'delisted', 'not_renewed'];
const SELLER_MOOD_OPTIONS = ['Open to Offers', 'Price Firm', 'Motivated to Sell', 'Testing the Market'];

// Listings that haven't been renewed within RENEWAL_WINDOW_DAYS get demoted to
// "not_renewed" status by the daily check. RENEWAL_WARNING_DAYS days before
// the cutoff, sellers get a heads-up email so they can renew in time.
const RENEWAL_WINDOW_DAYS = 60;
const RENEWAL_WARNING_DAYS = 7;

// Sellers in this sheet have their submissions and edits auto-approved
// (moderation_status='approved') instead of going through manual review.
// Keyed by lowercase email. Sheet schema: email (col A), name (col B),
// added_at (col C). The sheet is created on demand by
// getOrCreateTrustedSellersSheet_.
const TRUSTED_SELLERS_SHEET_NAME = 'Trusted Sellers';

function processArtworkSubmissions() {
  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const outputFolder = DriveApp.getFolderById(OUTPUT_FOLDER_ID);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  let nextListingIndex = computeNextListingIndex_(sheet, colMap);

  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const rowValues = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
    const row = buildRowObject_(headers, rowValues);

    const existingListingId = clean_(row['listing_id']);
    const sellerToken = getOrCreateSellerToken_(sheet, rowNumber, colMap, row);

    if (!existingListingId) {
      const listingId = buildListingId_(nextListingIndex);
      nextListingIndex++;
      const uploadCell = row[UPLOAD_IMAGE_COLUMN];
      const firstFileUrl = extractFirstUrl_(uploadCell);

      let sourceImageUrl = '';
      let imageFileName = '';

      if (firstFileUrl) {
        sourceImageUrl = firstFileUrl;
        let copied = null;

        try {
          copied = copyDriveImageToOutputFolder_(firstFileUrl, listingId, outputFolder);
        } catch (e) {
          Logger.log("Image failed for row " + rowNumber + ": " + e.message);
        }
        if (copied) {
          imageFileName = copied.imageFileName;
          sourceImageUrl = copied.sourceImageUrl;
        }
      }

      // Auto-approve if this seller is on the Trusted Sellers list.
      const isTrusted = isTrustedSeller_(row[SELLER_EMAIL_COLUMN]);
      const initialModerationStatus = isTrusted ? 'approved' : 'pending_review';

      sheet.getRange(rowNumber, colMap['listing_id']).setValue(listingId);
      sheet.getRange(rowNumber, colMap['image_file']).setValue(imageFileName);
      sheet.getRange(rowNumber, colMap['source_image_url']).setValue(sourceImageUrl);
      sheet.getRange(rowNumber, colMap['status']).setValue('available');
      sheet.getRange(rowNumber, colMap['moderation_status']).setValue(initialModerationStatus);
      sheet.getRange(rowNumber, colMap['updated_at']).setValue(new Date());
      if (colMap['last_renewed_at']) {
        sheet.getRange(rowNumber, colMap['last_renewed_at']).setValue(new Date());
      }

      if (sellerToken) {
        sheet.getRange(rowNumber, colMap['seller_token']).setValue(sellerToken);
      }

      if (isTrusted) {
        triggerCatalogRebuild_('auto_approve_new_listing:' + listingId);
      }
    } else {
      if (!clean_(row['status'])) {
        sheet.getRange(rowNumber, colMap['status']).setValue('available');
      }
      if (!clean_(row['moderation_status'])) {
        sheet.getRange(rowNumber, colMap['moderation_status']).setValue('pending_review');
      }
      // Lazy-initialize last_renewed_at for legacy listings (added before
      // the renewal feature shipped) so they get a fresh window from "now"
      // instead of being instantly demoted.
      if (colMap['last_renewed_at'] && !clean_(row['last_renewed_at'])) {
        sheet.getRange(rowNumber, colMap['last_renewed_at']).setValue(new Date());
      }
      if (sellerToken && !clean_(row['seller_token'])) {
        sheet.getRange(rowNumber, colMap['seller_token']).setValue(sellerToken);
      }
    }

    if (sellerToken && colMap[SELLER_PROFILE_URL_COLUMN]) {
      const inheritedProfileUrl = findExistingSellerProfileUrlByToken_(sheet, sellerToken, colMap);
      if (inheritedProfileUrl && !clean_(sheet.getRange(rowNumber, colMap[SELLER_PROFILE_URL_COLUMN]).getValue())) {
        sheet.getRange(rowNumber, colMap[SELLER_PROFILE_URL_COLUMN]).setValue(inheritedProfileUrl);
      }
    }

    maybeSendSellerManagementEmail_(sheet, rowNumber, colMap);
  }
}

function doGet(e) {
  if (e.parameter.page === 'admin') {
    if (!isAdminUser_()) {
      return HtmlService
        .createHtmlOutput('<p style="font-family:sans-serif;padding:24px;">This page is restricted to the site administrator.</p>')
        .setTitle('Access Denied');
    }
    return HtmlService
      .createHtmlOutputFromFile('admin_portal')
      .setTitle('Admin Portal');
  }

  const sellerToken = normalizeToken_(e && e.parameter ? e.parameter.seller_token : '');

  if (!sellerToken) {
    return HtmlService.createHtmlOutput('<p>Missing seller token.</p>').setTitle(PORTAL_TITLE);
  }

  const template = HtmlService.createTemplateFromFile('seller_portal');
  template.portalTitle = PORTAL_TITLE;
  template.sellerToken = sellerToken;
  template.publicBaseUrl = PUBLIC_BASE_URL;

  return template
    .evaluate()
    .setTitle(PORTAL_TITLE)
    .setFaviconUrl(SELLER_PORTAL_FAVICON_URL)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getSellerPortalBootstrap(sellerToken) {
  sellerToken = normalizeToken_(sellerToken);
  const listings = getSellerListings_(sellerToken);

  if (!listings.length) {
    return {
      sellerToken: sellerToken,
      sellerName: '',
      sellerPostHeader: '',
      sellerPostFooter: '',
      publicBaseUrl: PUBLIC_BASE_URL,
      listings: [],
      statusOptions: STATUS_OPTIONS,
      moodOptions: SELLER_MOOD_OPTIONS,
      renewalWindowDays: RENEWAL_WINDOW_DAYS,
      renewalWarningDays: RENEWAL_WARNING_DAYS,
    };
  }

  return {
    sellerToken: sellerToken,
    sellerName: listings[0].seller_name || '',
    sellerPostHeader: listings[0].seller_post_header || '',
    sellerPostFooter: listings[0].seller_post_footer || '',
    sellerLocation: listings[0].seller_location || '',
    publicBaseUrl: PUBLIC_BASE_URL,
    listings: listings,
    statusOptions: STATUS_OPTIONS,
    moodOptions: SELLER_MOOD_OPTIONS,
  };
}

function saveSellerListingUpdate(payload) {
  const sellerToken = normalizeToken_(payload && payload.sellerToken ? payload.sellerToken : '');
  const listingId = clean_(payload && payload.listingId ? payload.listingId : '');

  if (!sellerToken || !listingId) {
    throw new Error('Missing seller token or listing ID.');
  }

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No listings found.');

  const listingMatch = findListingRowByIdAndToken_(sheet, headers, listingId, sellerToken);
  if (!listingMatch) {
    throw new Error('Listing not found for this seller token.');
  }

  const rowNumber = listingMatch.rowNumber;
  const row = listingMatch.row;
  const now = new Date();
  const sellerProfileUrl = normalizeSellerProfileUrl_(payload.seller_profile_url);

  if (sellerProfileUrl && colMap[SELLER_PROFILE_URL_COLUMN]) {
    updateSellerProfileUrlForToken_(sheet, headers, colMap, sellerToken, sellerProfileUrl);
  }

  const editableFields = {
    'Artwork Title': clean_(payload.artwork_title),
    'Artist Name': clean_(payload.artist_name),
    'Medium/Type': clean_(payload.medium),
    'Artwork Size (inches)': clean_(payload.artwork_size_inches),
    'Framed Size (inches)': clean_(payload.framed_size_inches),
    'Price (USD)': clean_(payload.price),
    [SHIPPING_COLUMN]: normalizeYesNoText_(payload.shipping_included),
    [COA_COLUMN]: normalizeYesNoText_(payload.certificate_of_authenticity_included),
    [SELLER_NOTES_COLUMN]: clean_(payload.seller_notes),
    'status': normalizeStatus_(payload.status),
    'seller_mood': normalizeSellerMood_(payload.seller_mood),
  };

  Object.keys(editableFields).forEach((columnName) => {
    if (colMap[columnName]) {
      sheet.getRange(rowNumber, colMap[columnName]).setValue(editableFields[columnName]);
    }
  });

  const oldPrice = clean_(row['Price (USD)']);
  const newPrice = clean_(payload.price);

  if (newPrice && oldPrice && oldPrice !== newPrice) {
    const oldNum = normalizeNumberMaybe_(oldPrice);
    const newNum = normalizeNumberMaybe_(newPrice);

    if (oldNum !== null && newNum !== null && newNum < oldNum) {
      if (colMap['previous_price']) {
        sheet.getRange(rowNumber, colMap['previous_price']).setValue(oldPrice);
      }
      if (colMap['price_updated_at']) {
        sheet.getRange(rowNumber, colMap['price_updated_at']).setValue(now);
      }
    } else if (colMap['previous_price']) {
      sheet.getRange(rowNumber, colMap['previous_price']).clearContent();
    }
  }

  const uploadedImage = payload && payload.new_image_upload ? payload.new_image_upload : null;

  if (uploadedImage && uploadedImage.base64) {
    const outputFolder = DriveApp.getFolderById(OUTPUT_FOLDER_ID);
    const uploaded = saveUploadedImageToOutputFolder_(uploadedImage, listingId, outputFolder);

    if (!uploaded) {
      throw new Error('Could not upload the replacement image.');
    }

    if (colMap['source_image_url']) {
      sheet.getRange(rowNumber, colMap['source_image_url']).setValue(uploaded.sourceImageUrl);
    }

    if (colMap[UPLOAD_IMAGE_COLUMN]) {
      sheet.getRange(rowNumber, colMap[UPLOAD_IMAGE_COLUMN]).setValue(uploaded.sourceImageUrl);
    }

    if (colMap['image_file']) {
      sheet.getRange(rowNumber, colMap['image_file']).setValue(uploaded.imageFileName);
    }

    if (colMap['moderation_status']) {
      sheet.getRange(rowNumber, colMap['moderation_status']).setValue(
        isTrustedSeller_(row[SELLER_EMAIL_COLUMN]) ? 'approved' : 'pending_review'
      );
    }
  }

  // Fields whose changes warrant admin re-review for non-trusted sellers
  // (description-style edits — title, artist, medium, sizes, shipping, COA, notes).
  const reviewableFieldsChanged = [
    'Artwork Title',
    'Artist Name',
    'Medium/Type',
    'Artwork Size (inches)',
    'Framed Size (inches)',
    SHIPPING_COLUMN,
    COA_COLUMN,
    SELLER_NOTES_COLUMN,
  ].some((columnName) => clean_(row[columnName]) !== editableFields[columnName]);

  // Superset: any change that affects the public catalog's rendering of this
  // listing. Price, status, and seller_mood don't need re-review but DO need
  // the catalog rebuilt so trusted sellers' updates appear live.
  const visibleFieldsChanged = reviewableFieldsChanged || [
    'Price (USD)',
    'status',
    'seller_mood',
  ].some((columnName) => clean_(row[columnName]) !== editableFields[columnName]);

  // If reviewable fields changed (or an image was replaced), set
  // moderation_status — 'approved' for trusted sellers, 'pending_review'
  // otherwise. Price/status/mood-only edits don't reset moderation.
  const trustedEditor = isTrustedSeller_(row[SELLER_EMAIL_COLUMN]);
  const imageReplaced = !!(uploadedImage && uploadedImage.base64);

  if (reviewableFieldsChanged && colMap['moderation_status']) {
    sheet.getRange(rowNumber, colMap['moderation_status']).setValue(
      trustedEditor ? 'approved' : 'pending_review'
    );
  }

  // For trusted sellers, ANY visible change triggers a debounced rebuild so
  // the live site picks up the edit without admin action.
  if (trustedEditor && (visibleFieldsChanged || imageReplaced)) {
    triggerCatalogRebuild_('auto_approve_edit:' + listingId);
  }

  if (colMap['updated_at']) {
    sheet.getRange(rowNumber, colMap['updated_at']).setValue(now);
  }
  // Saving a listing counts as seller engagement — refresh its renewal clock
  // so the seller doesn't get demoted just because they recently edited.
  if (colMap['last_renewed_at']) {
    sheet.getRange(rowNumber, colMap['last_renewed_at']).setValue(now);
  }
  if (colMap['renewal_warning_sent_at']) {
    sheet.getRange(rowNumber, colMap['renewal_warning_sent_at']).clearContent();
  }

  SpreadsheetApp.flush();
  return getSellerPortalBootstrap(sellerToken);
}

function getSellerListings_(sellerToken) {
  sellerToken = normalizeToken_(sellerToken);

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const listings = [];

  values.forEach((rowValues, index) => {
    const row = buildRowObject_(headers, rowValues);
    const rowToken = normalizeToken_(row['seller_token']);
    if (rowToken !== sellerToken) return;

    // Hide delisted listings from the seller portal — sellers use "delisted"
    // as their way to remove a listing from the portal completely.
    const rowStatus = (normalizeStatus_(row['status']) || 'available').toLowerCase();
    if (rowStatus === 'delisted') return;

    const rawImageUrl = clean_(row['source_image_url']) || clean_(row[UPLOAD_IMAGE_COLUMN]);

    listings.push({
      rowNumber: index + 2,
      listing_id: clean_(row['listing_id']),
      seller_name: clean_(row['Seller Name']),
      seller_email: clean_(row[SELLER_EMAIL_COLUMN]),
      seller_profile_url: clean_(row[SELLER_PROFILE_URL_COLUMN]) || clean_(row[SELLER_PROFILE_COLUMN]),
      artist_name: clean_(row['Artist Name']),
      artwork_title: clean_(row['Artwork Title']),
      medium: clean_(row['Medium/Type']),
      artwork_category: normalizeArtworkCategory_(row[ARTWORK_CATEGORY_COLUMN]),
      artwork_size_inches: clean_(row['Artwork Size (inches)']),
      framed_size_inches: clean_(row['Framed Size (inches)']),
      price: clean_(row['Price (USD)']),
      shipping_included: normalizeYesNoText_(row[SHIPPING_COLUMN]),
      certificate_of_authenticity_included: normalizeYesNoText_(row[COA_COLUMN]),
      seller_notes: clean_(row[SELLER_NOTES_COLUMN]),
      status: normalizeStatus_(row['status']) || 'available',
      moderation_status: clean_(row['moderation_status']) || 'pending_review',
      image_file: clean_(row['image_file']),
      source_image_url: buildDisplayImageUrl_(rawImageUrl),
      previous_price: clean_(row['previous_price']),
      price_updated_at: formatDateIsoMaybe_(row['price_updated_at']),
      updated_at: formatDateIsoMaybe_(row['updated_at']),
      seller_post_header: clean_(row['seller_post_header']),
      seller_post_footer: clean_(row['seller_post_footer']),
      seller_location: clean_(row['seller_location']),
      seller_mood: normalizeSellerMood_(row['seller_mood']),
      last_renewed_at: formatDateIsoMaybe_(row['last_renewed_at']),
      days_since_renewal: daysSinceRenewal_(row),
    });
  });

  return listings.sort((a, b) => a.listing_id.localeCompare(b.listing_id));
}

function findListingRowByIdAndToken_(sheet, headers, listingId, sellerToken) {
  const normalizedSellerToken = normalizeToken_(sellerToken);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (let i = 0; i < values.length; i++) {
    const row = buildRowObject_(headers, values[i]);
    if (
      clean_(row['listing_id']) === listingId &&
      normalizeToken_(row['seller_token']) === normalizedSellerToken
    ) {
      return { rowNumber: i + 2, row: row };
    }
  }

  return null;
}

function maybeSendSellerManagementEmail_(sheet, rowNumber, colMap, options) {
  const isRotation = !!(options && options.isRotation);

  const rowValues = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const row = buildRowObject_(headers, rowValues);

  const sellerEmail = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
  const sellerToken = normalizeToken_(row['seller_token']);
  const listingId = clean_(row['listing_id']);
  const sentAt = clean_(row['management_link_sent_at']);
  const lastSentTo = clean_(row['management_link_last_sent_to']).toLowerCase();

  if (!sellerEmail || !sellerToken || !listingId) return;

  // For first-time sends, dedupe — don't email the same seller twice.
  // Rotations always force-send: the seller needs the new link.
  if (!isRotation) {
    if (sentAt && lastSentTo === sellerEmail) return;
  }

  // Do not send again if this seller email has already received a management link
  // on any other row. One seller token manages all current/future listings for that email.
  // (Skipped for rotations — rotation explicitly clears all prior-send markers.)
  const priorSend = isRotation ? null : findPriorManagementEmailForSeller_(sheet, sellerEmail, rowNumber);
  if (priorSend) {
    if (colMap['management_link_sent_at']) {
      sheet.getRange(rowNumber, colMap['management_link_sent_at']).setValue(priorSend.sentAt);
    }
    if (colMap['management_link_last_sent_to']) {
      sheet.getRange(rowNumber, colMap['management_link_last_sent_to']).setValue(sellerEmail);
    }
    Logger.log('Skipping seller management email for ' + sellerEmail + '; already sent on row ' + priorSend.rowNumber + '.');
    return;
  }

  const portalUrl = getSellerPortalUrl_(sellerToken);
  if (!portalUrl) {
    Logger.log('Skipping seller management email because SELLER_PORTAL_BASE_URL is not configured.');
    return;
  }

  const sellerName = clean_(row['Seller Name']) || 'there';
  const artistName = clean_(row['Artist Name']);
  const artworkTitle = clean_(row['Artwork Title']) || listingId;

  const listingLabel = artistName
    ? artistName + ' — ' + artworkTitle
    : artworkTitle;

  const subject = isRotation
    ? 'Canvas Circle — your new seller management link'
    : 'Welcome to Canvas Circle — your listing for ' + listingLabel + ' has been received';

  const htmlBody = buildManagementEmailHtml_(sellerName, listingLabel, portalUrl, isRotation);
  const plainBody = buildManagementEmailText_(sellerName, listingLabel, portalUrl, isRotation);

  MailApp.sendEmail({
    to: sellerEmail,
    subject: subject,
    htmlBody: htmlBody,
    body: plainBody,
    name: EMAIL_FROM_NAME,
  });

  if (colMap['management_link_sent_at']) {
    sheet.getRange(rowNumber, colMap['management_link_sent_at']).setValue(new Date());
  }
  if (colMap['management_link_last_sent_to']) {
    sheet.getRange(rowNumber, colMap['management_link_last_sent_to']).setValue(sellerEmail);
  }
}

function findPriorManagementEmailForSeller_(sheet, sellerEmail, currentRowNumber) {
  const normalizedEmail = clean_(sellerEmail).toLowerCase();
  if (!normalizedEmail) return null;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    if (rowNumber === currentRowNumber) continue;

    const row = buildRowObject_(headers, values[i]);
    const rowEmail = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
    const rowSentAt = row['management_link_sent_at'];
    const rowLastSentTo = clean_(row['management_link_last_sent_to']).toLowerCase();

    if (rowEmail === normalizedEmail && rowSentAt && rowLastSentTo === normalizedEmail) {
      return {
        rowNumber: rowNumber,
        sentAt: rowSentAt,
      };
    }
  }

  return null;
}

function resendSellerManagementLinkByEmail(sellerEmail) {
  sellerEmail = clean_(sellerEmail).toLowerCase();
  if (!sellerEmail) throw new Error('Missing seller email.');

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No listing rows found.');

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const row = buildRowObject_(headers, values[i]);
    const rowEmail = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
    if (rowEmail !== sellerEmail) continue;

    const sellerToken = normalizeToken_(row['seller_token']);

    if (colMap['management_link_sent_at']) {
      sheet.getRange(rowNumber, colMap['management_link_sent_at']).clearContent();
    }
    if (colMap['management_link_last_sent_to']) {
      sheet.getRange(rowNumber, colMap['management_link_last_sent_to']).clearContent();
    }

    if (sellerToken && colMap[SELLER_PROFILE_URL_COLUMN]) {
      const inheritedProfileUrl = findExistingSellerProfileUrlByToken_(sheet, sellerToken, colMap);
      if (inheritedProfileUrl && !clean_(sheet.getRange(rowNumber, colMap[SELLER_PROFILE_URL_COLUMN]).getValue())) {
        sheet.getRange(rowNumber, colMap[SELLER_PROFILE_URL_COLUMN]).setValue(inheritedProfileUrl);
      }
    }

    maybeSendSellerManagementEmail_(sheet, rowNumber, colMap);
    return;
  }

  throw new Error('No listing found for seller email: ' + sellerEmail);
}

function rotateSellerTokenByEmail(sellerEmail) {
  if (!isAdminUser_()) {
    throw new Error('Not authorized.');
  }

  sellerEmail = clean_(sellerEmail).toLowerCase();
  if (!sellerEmail) throw new Error('Missing seller email.');

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);

  if (!colMap['seller_token']) {
    throw new Error('seller_token column missing from sheet.');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No listing rows found.');

  const newToken = Utilities.getUuid();
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  let firstMatchRow = 0;
  let matchCount = 0;

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const row = buildRowObject_(headers, values[i]);
    const rowEmail = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
    if (rowEmail !== sellerEmail) continue;

    matchCount++;
    if (!firstMatchRow) firstMatchRow = rowNumber;

    sheet.getRange(rowNumber, colMap['seller_token']).setValue(newToken);

    if (colMap['management_link_sent_at']) {
      sheet.getRange(rowNumber, colMap['management_link_sent_at']).clearContent();
    }
    if (colMap['management_link_last_sent_to']) {
      sheet.getRange(rowNumber, colMap['management_link_last_sent_to']).clearContent();
    }
  }

  if (!matchCount) {
    throw new Error('No listings found for seller email: ' + sellerEmail);
  }

  SpreadsheetApp.flush();
  maybeSendSellerManagementEmail_(sheet, firstMatchRow, colMap, { isRotation: true });

  return {
    seller_email: sellerEmail,
    rotated_count: matchCount,
  };
}

function buildManagementEmailHtml_(sellerName, listingLabel, portalUrl, isRotation) {
  const introHtml = isRotation
    ? `<p>Your <strong>Canvas Circle</strong> seller management link has been rotated. The previous link no longer works — please use the new one below from now on.</p>`
    : `<p>Welcome to <strong>Canvas Circle</strong> — thank you for submitting your artwork. Your listing for <strong>${escapeHtml_(listingLabel)}</strong> has been received and will appear on the catalog at <a href="https://canvascircle.art">canvascircle.art</a> once it's approved.</p>`;

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#1f1a17;max-width:640px;">
      <p>Hi ${escapeHtml_(sellerName)},</p>
      ${introHtml}
      <p>This is your private Canvas Circle seller management link. <strong>One link manages every listing you submit with this email address</strong> — edit details, update prices, replace images, or change listing status (Available / Pending / Sold / Remove from seller portal) anytime.</p>
      <p style="margin:24px 0;">
        <a href="${portalUrl}" style="background:#1f1a17;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:999px;display:inline-block;font-weight:600;">Manage My Listings</a>
      </p>
      <p>If the button does not work, copy and paste this link into your browser:</p>
      <p><a href="${portalUrl}">${portalUrl}</a></p>
      <p style="color:#6f675e;font-size:13px;">Please keep this link private — anyone who has it can manage your listings. If you ever think it has been shared, reply to this email and we'll rotate it.</p>
      <p style="margin-top:28px;">— The Canvas Circle team</p>
    </div>
  `;
}

function buildManagementEmailText_(sellerName, listingLabel, portalUrl, isRotation) {
  const introText = isRotation
    ? 'Your Canvas Circle seller management link has been rotated. The previous link no longer works — please use the new one below from now on.'
    : `Welcome to Canvas Circle — thank you for submitting your artwork. Your listing for ${listingLabel} has been received and will appear on the catalog at canvascircle.art once it's approved.`;

  return [
    `Hi ${sellerName},`,
    '',
    introText,
    '',
    'This is your private Canvas Circle seller management link. One link manages every listing you submit with this email address — edit details, update prices, replace images, or change listing status (Available / Pending / Sold / Remove from seller portal) anytime:',
    portalUrl,
    '',
    "Please keep this link private — anyone who has it can manage your listings. If you ever think it has been shared, reply to this email and we'll rotate it.",
    '',
    '— The Canvas Circle team',
  ].join('\n');
}

function getSellerPortalUrl_(sellerToken) {
  const baseUrl = clean_(SELLER_PORTAL_BASE_URL);
  if (!baseUrl) return '';
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}seller_token=${encodeURIComponent(normalizeToken_(sellerToken))}`;
}


function normalizeSellerProfileUrl_(value) {
  const raw = clean_(value);
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (/^(www\.)?facebook\.com\//i.test(raw) || /^(www\.)?fb\.com\//i.test(raw) || /^(www\.)?m\.facebook\.com\//i.test(raw)) {
    return `https://${raw}`;
  }

  return raw;
}

function findExistingSellerProfileUrlByToken_(sheet, sellerToken, colMap) {
  if (!sellerToken || !colMap[SELLER_PROFILE_URL_COLUMN] || !colMap['seller_token']) return '';

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (let i = 0; i < values.length; i++) {
    const rowToken = clean_(values[i][colMap['seller_token'] - 1]);
    const profileUrl = clean_(values[i][colMap[SELLER_PROFILE_URL_COLUMN] - 1]);

    if (rowToken === sellerToken && profileUrl) {
      return profileUrl;
    }
  }

  return '';
}

function updateSellerProfileUrlForToken_(sheet, headers, colMap, sellerToken, sellerProfileUrl) {
  if (!sellerToken || !sellerProfileUrl) return;
  if (!colMap[SELLER_PROFILE_URL_COLUMN] || !colMap['seller_token']) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const rowToken = clean_(values[i][colMap['seller_token'] - 1]);

    if (rowToken === sellerToken) {
      sheet.getRange(rowNumber, colMap[SELLER_PROFILE_URL_COLUMN]).setValue(sellerProfileUrl);

      if (colMap['updated_at']) {
        sheet.getRange(rowNumber, colMap['updated_at']).setValue(new Date());
      }
    }
  }
}

// Strips common prefixes a seller might write (e.g. "Located in Central NJ"
// → "Central NJ"). The catalog renders "Location: X" automatically, so this
// keeps the display from reading "Location: Located in Central NJ".
function normalizeSellerLocation_(value) {
  let raw = clean_(value);
  if (!raw) return '';
  // Drop leading prefixes case-insensitively.
  raw = raw.replace(/^(located\s+(in|at)|i'?m\s+(in|at|located|based)|i\s+am\s+(in|at|located|based)|based\s+(in|out\s+of)|location:?)\s+/i, '');
  // Drop a leading "in " if it survives ("In Central NJ" → "Central NJ").
  raw = raw.replace(/^in\s+/i, '');
  return clean_(raw);
}

// Propagate a seller's location to every row that belongs to their token,
// same pattern as updateSellerProfileUrlForToken_. Empty value is allowed
// (clears the field across all rows).
function updateSellerLocationForToken_(sheet, colMap, sellerToken, sellerLocation) {
  if (!sellerToken) return;
  if (!colMap['seller_location'] || !colMap['seller_token']) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const rowToken = clean_(values[i][colMap['seller_token'] - 1]);
    if (rowToken !== sellerToken) continue;

    sheet.getRange(rowNumber, colMap['seller_location']).setValue(sellerLocation);
    if (colMap['updated_at']) {
      sheet.getRange(rowNumber, colMap['updated_at']).setValue(now);
    }
  }
}

// Dedicated seller-portal endpoint for the Save Location button. Mirrors
// saveSellerPostTexts in spirit. Passing an empty string clears the
// location on every row.
function saveSellerLocation(payload) {
  const sellerToken = normalizeToken_(payload && payload.sellerToken ? payload.sellerToken : '');
  if (!sellerToken) throw new Error('Missing seller token.');

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);

  const normalized = normalizeSellerLocation_(payload && payload.sellerLocation);
  updateSellerLocationForToken_(sheet, colMap, sellerToken, normalized);

  SpreadsheetApp.flush();
  return getSellerPortalBootstrap(sellerToken);
}

function renewSellerListings(sellerToken) {
  // Public seller-portal endpoint. Resets last_renewed_at = now for every
  // available/pending/not_renewed listing owned by the matching token.
  // Listings currently in "not_renewed" are flipped back to "available".
  // Sold/delisted listings are intentionally left alone.
  sellerToken = normalizeToken_(sellerToken);
  if (!sellerToken) {
    throw new Error('Missing seller token.');
  }

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('No listings found.');
  }

  if (!colMap['last_renewed_at']) {
    throw new Error('last_renewed_at column missing from sheet.');
  }

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();
  let renewedCount = 0;
  let revivedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const row = buildRowObject_(headers, values[i]);
    const rowToken = normalizeToken_(row['seller_token']);
    if (rowToken !== sellerToken) continue;

    const status = clean_(row['status']).toLowerCase();
    if (!isRenewableStatus_(status)) continue;

    sheet.getRange(rowNumber, colMap['last_renewed_at']).setValue(now);
    if (colMap['renewal_warning_sent_at']) {
      sheet.getRange(rowNumber, colMap['renewal_warning_sent_at']).clearContent();
    }
    if (status === 'not_renewed') {
      sheet.getRange(rowNumber, colMap['status']).setValue('available');
      revivedCount++;
    }
    if (colMap['updated_at']) {
      sheet.getRange(rowNumber, colMap['updated_at']).setValue(now);
    }
    renewedCount++;
  }

  if (!renewedCount) {
    throw new Error('No renewable listings found for this seller.');
  }

  SpreadsheetApp.flush();
  // If any listings came back from not_renewed, the public catalog needs to
  // re-render to include them again. (Plain renewals don't change visibility,
  // but rebuilding is harmless and keeps things consistent.)
  triggerCatalogRebuild_('seller_renewal:' + sellerToken.slice(0, 8));

  return {
    renewedCount: renewedCount,
    revivedCount: revivedCount,
    renewedAt: now.toISOString(),
  };
}

function saveSellerPostTexts(payload) {
  // Persists per-seller header/footer text across every row that belongs to this
  // seller_token. Called from the seller portal builder modal.
  const sellerToken = normalizeToken_(payload && payload.sellerToken ? payload.sellerToken : '');
  if (!sellerToken) {
    throw new Error('Missing seller token.');
  }

  const header = clean_(payload && payload.sellerPostHeader ? payload.sellerPostHeader : '');
  const footer = clean_(payload && payload.sellerPostFooter ? payload.sellerPostFooter : '');

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('No listings found.');
  }

  if (!colMap['seller_token']) {
    throw new Error('seller_token column not found.');
  }

  const headerCol = colMap['seller_post_header'];
  const footerCol = colMap['seller_post_footer'];
  if (!headerCol || !footerCol) {
    throw new Error('seller_post_header / seller_post_footer columns not found.');
  }

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  let touched = 0;
  const now = new Date();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const rowToken = clean_(values[i][colMap['seller_token'] - 1]);
    if (rowToken !== sellerToken) continue;

    sheet.getRange(rowNumber, headerCol).setValue(header);
    sheet.getRange(rowNumber, footerCol).setValue(footer);
    if (colMap['updated_at']) {
      sheet.getRange(rowNumber, colMap['updated_at']).setValue(now);
    }
    touched++;
  }

  if (!touched) {
    throw new Error('No listings matched this seller token.');
  }

  SpreadsheetApp.flush();
  return getSellerPortalBootstrap(sellerToken);
}


function getListingsSheet_() {
  return SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
}

function ensureRequiredColumns_(sheet) {
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(h => String(h).trim());

  REQUIRED_COLUMNS.forEach(col => {
    if (!headers.includes(col)) {
      sheet.getRange(1, headers.length + 1).setValue(col);
      headers.push(col); // ← CRITICAL FIX
    }
  });

  return headers;
}

function ensureColumn_(sheet, columnName) {
  const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((v) => String(v).trim());
  if (!existingHeaders.includes(columnName)) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(columnName);
  }
}

function getColumnMap_(headers) {
  const map = {};
  headers.forEach((header, idx) => {
    map[String(header).trim()] = idx + 1;
  });
  return map;
}

function buildRowObject_(headers, rowValues) {
  const row = {};
  headers.forEach((header, idx) => {
    row[String(header).trim()] = rowValues[idx];
  });
  return row;
}

function buildListingId_(index) {
  return `listing_${String(index).padStart(4, '0')}`;
}

function computeNextListingIndex_(sheet, colMap) {
  const lastRow = sheet.getLastRow();
  const listingIdCol = colMap && colMap['listing_id'];
  if (lastRow < 2 || !listingIdCol) return 1;

  const ids = sheet.getRange(2, listingIdCol, lastRow - 1, 1).getValues();
  let maxIndex = 0;

  ids.forEach(([id]) => {
    const match = String(id || '').match(/^listing_(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxIndex) {
        maxIndex = num;
      }
    }
  });

  return maxIndex + 1;
}

function getOrCreateSellerToken_(sheet, rowNumber, colMap, row) {
  const existing = normalizeToken_(row['seller_token']);
  if (existing) return existing;

  const sellerKey = buildSellerKey_(row);
  if (!sellerKey) return '';

  const reusableToken = findExistingSellerTokenByKey_(sheet, sellerKey);
  const token = reusableToken || Utilities.getUuid();

  if (colMap['seller_token']) {
    sheet.getRange(rowNumber, colMap['seller_token']).setValue(token);
  }

  return token;
}

function buildSellerKey_(row) {
  const sellerEmail = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
  if (sellerEmail) return `email||${sellerEmail}`;

  const sellerName = clean_(row['Seller Name']).toLowerCase();
  const sellerProfile = clean_(row[SELLER_PROFILE_COLUMN]).toLowerCase();
  const combined = `${sellerName}||${sellerProfile}`.replace(/^\|\|$/, '');
  return combined;
}

function findExistingSellerTokenByKey_(sheet, sellerKey) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (let i = 0; i < values.length; i++) {
    const row = buildRowObject_(headers, values[i]);
    if (buildSellerKey_(row) === sellerKey) {
      const token = normalizeToken_(row['seller_token']);
      if (token) return token;
    }
  }

  return '';
}

function copyDriveImageToOutputFolder_(url, listingId, outputFolder) {
  const sourceImageUrl = extractFirstUrl_(url);
  if (!sourceImageUrl) return null;

  const fileId = extractDriveFileId_(sourceImageUrl);
  if (!fileId) return null;

  const originalFile = DriveApp.getFileById(fileId);
  const extension = getFileExtension_(originalFile.getName()) || 'jpg';
  const tempFileName = `${listingId}_temp.${extension}`;

  // Trash any leftover temp file from a previous run
  const existingFiles = outputFolder.getFilesByName(tempFileName);
  while (existingFiles.hasNext()) {
    existingFiles.next().setTrashed(true);
  }

  // Copy the original into OUTPUT_FOLDER as a temp file with public sharing,
  // so Drive's thumbnail URL can resize it for the compressed copy.
  const tempCopy = originalFile.makeCopy(tempFileName, outputFolder);
  tempCopy.setName(tempFileName);
  tempCopy.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return compressOrFallback_(tempCopy, listingId, outputFolder, extension);
}

function saveUploadedImageToOutputFolder_(uploadedImage, listingId, outputFolder) {
  if (!uploadedImage || !uploadedImage.base64) return null;

  const contentType = uploadedImage.type || 'image/jpeg';
  const originalName = uploadedImage.name || `${listingId}.jpg`;
  const sourceExtension =
    getFileExtension_(originalName) || extensionFromMimeType_(contentType) || 'jpg';
  const tempFileName = `${listingId}_temp.${sourceExtension}`;

  const bytes = Utilities.base64Decode(uploadedImage.base64);
  const blob = Utilities.newBlob(bytes, contentType, tempFileName);

  // Trash any leftover temp file from a previous run
  const existingFiles = outputFolder.getFilesByName(tempFileName);
  while (existingFiles.hasNext()) {
    existingFiles.next().setTrashed(true);
  }

  // Save the upload as a temp file with public sharing, then route through the
  // shared compress-or-fallback helper.
  const tempFile = outputFolder.createFile(blob);
  tempFile.setName(tempFileName);
  tempFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return compressOrFallback_(tempFile, listingId, outputFolder, sourceExtension);
}

function buildDisplayImageUrl_(url) {
  const cleanUrl = clean_(url);
  if (!cleanUrl) return '';

  const fileId = extractDriveFileId_(cleanUrl);
  if (!fileId) return cleanUrl;

  // Use Google's lh3 CDN directly rather than drive.google.com/thumbnail.
  // The thumbnail endpoint redirects to lh3 anyway, but iOS Safari can drop
  // image loads from inside the Apps Script iframe context — skipping the
  // redirect makes the request shape simpler and serves reliably.
  return `https://lh3.googleusercontent.com/d/${fileId}=w1200`;
}

function extensionFromMimeType_(mimeType) {
  const type = clean_(mimeType).toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return '';
}

function extractFirstUrl_(cellValue) {
  if (!cellValue) return '';
  const text = String(cellValue).trim();
  if (text.includes(',')) return text.split(',')[0].trim();
  if (text.includes('\n')) return text.split('\n')[0].trim();
  return text;
}

function extractDriveFileId_(url) {
  if (!url) return null;

  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/open\?id=([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];

  for (const pattern of patterns) {
    const match = String(url).match(pattern);
    if (match) return match[1];
  }

  return null;
}

function getFileExtension_(filename) {
  const parts = String(filename).split('.');
  if (parts.length < 2) return '';
  return parts.pop().toLowerCase();
}

function clean_(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeToken_(value) {
  return clean_(value).replace(/^"+|"+$/g, '');
}

function normalizeYesNoText_(value) {
  const normalized = clean_(value).toLowerCase();

  if (normalized === 'yes' || normalized === 'true' || normalized === '1') return 'Yes';
  if (normalized === 'no' || normalized === 'false' || normalized === '0') return 'No';

  return '';
}

function normalizeArtworkCategory_(value) {
  // Mirrors the Python catalog generator's normalize_artwork_category — returns
  // either "Unique/Original" or "Limited Edition" (or empty string if blank /
  // unrecognized) so the seller portal can display it consistently with the
  // public catalog's badges.
  const raw = clean_(value);
  if (!raw) return '';

  const normalized = raw.toLowerCase().replace(/[\s\-_]+/g, '');
  if (normalized.indexOf('limited') !== -1) return 'Limited Edition';
  if (normalized.indexOf('unique') !== -1 || normalized.indexOf('original') !== -1) {
    return 'Unique/Original';
  }
  return raw;
}

function normalizeSellerMood_(value) {
  // Returns one of SELLER_MOOD_OPTIONS exactly, or empty string for "no mood set".
  const raw = clean_(value);
  if (!raw) return '';
  // Match case-insensitively to be tolerant of slight spreadsheet drift.
  const lower = raw.toLowerCase();
  for (let i = 0; i < SELLER_MOOD_OPTIONS.length; i++) {
    if (SELLER_MOOD_OPTIONS[i].toLowerCase() === lower) return SELLER_MOOD_OPTIONS[i];
  }
  return '';
}

function normalizeStatus_(value) {
  const normalized = clean_(value).toLowerCase();
  return STATUS_OPTIONS.includes(normalized) ? normalized : 'available';
}

function daysSinceRenewal_(row) {
  // Returns number of full days since last_renewed_at, or null if the column
  // is unset or unparseable. Null is treated as "needs initialization" rather
  // than "infinitely old" so we don't accidentally mass-demote on first run.
  const raw = row && row['last_renewed_at'];
  if (!raw && raw !== 0) return null;
  const date = (Object.prototype.toString.call(raw) === '[object Date]')
    ? raw
    : new Date(raw);
  if (!date || isNaN(date.getTime())) return null;
  const ms = Date.now() - date.getTime();
  return Math.floor(ms / 86400000);
}

function isRenewableStatus_(status) {
  // Statuses where renewal makes sense — sold/delisted are terminal.
  const s = clean_(status).toLowerCase();
  return s === 'available' || s === 'pending' || s === 'not_renewed';
}

function isExpirable_(status) {
  // Statuses the daily expiration job should consider for demotion.
  const s = clean_(status).toLowerCase();
  return s === 'available' || s === 'pending';
}

function normalizeNumberMaybe_(value) {
  const cleaned = clean_(value).replace(/[$,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateIsoMaybe_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  const date = new Date(value);
  return isNaN(date.getTime()) ? clean_(value) : date.toISOString();
}

function escapeHtml_(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isAdminUser_() {
  try {
    const visitor = clean_(Session.getActiveUser().getEmail()).toLowerCase();
    if (!visitor) return false;
    return visitor === clean_(ADMIN_EMAIL).toLowerCase();
  } catch (err) {
    Logger.log('isAdminUser_ check failed: ' + (err && err.message ? err.message : err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trusted sellers — auto-approve submissions and edits.
//
// When a seller's email is on this list, their new listings (via the intake
// form) and content edits (via the seller portal) skip manual review:
// moderation_status is set directly to 'approved' and a catalog rebuild is
// queued through the debounced dispatcher.
//
// Storage is a separate sheet ("Trusted Sellers") keyed by lowercase email.
// Edits to this sheet take effect immediately on the next read — no
// redeploy needed.
// ---------------------------------------------------------------------------

function getOrCreateTrustedSellersSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(TRUSTED_SELLERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TRUSTED_SELLERS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['email', 'name', 'added_at']]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  return sheet;
}

// Returns a Set of trusted seller emails (lowercase, trimmed).
function getTrustedSellerEmails_() {
  const sheet = getOrCreateTrustedSellersSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const emails = new Set();
  values.forEach(r => {
    const email = clean_(r[0]).toLowerCase();
    if (email) emails.add(email);
  });
  return emails;
}

function isTrustedSeller_(email) {
  const e = clean_(email).toLowerCase();
  if (!e) return false;
  return getTrustedSellerEmails_().has(e);
}

// Adds or removes a seller from the trusted list. Idempotent.
function setSellerTrusted_(email, name, trusted) {
  const normalizedEmail = clean_(email).toLowerCase();
  if (!normalizedEmail) throw new Error('Email required.');

  const sheet = getOrCreateTrustedSellersSheet_();
  const lastRow = sheet.getLastRow();
  let foundRow = -1;

  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (clean_(values[i][0]).toLowerCase() === normalizedEmail) {
        foundRow = i + 2;
        break;
      }
    }
  }

  if (trusted && foundRow < 0) {
    sheet.appendRow([normalizedEmail, clean_(name) || '', new Date()]);
  } else if (!trusted && foundRow > 0) {
    sheet.deleteRow(foundRow);
  } else if (trusted && foundRow > 0 && clean_(name)) {
    // Refresh the cached display name if we have a better one.
    sheet.getRange(foundRow, 2).setValue(clean_(name));
  }
}

// Returns every seller known to the system (one row per distinct email
// from the listings sheet) joined with their trust state. Used to populate
// the admin portal's searchable picker.
function getKnownSellersWithTrust_() {
  const listingsSheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(listingsSheet);
  const lastRow = listingsSheet.getLastRow();
  const trusted = getTrustedSellerEmails_();
  const bySeller = {};

  if (lastRow >= 2) {
    const values = listingsSheet.getRange(2, 1, lastRow - 1, listingsSheet.getLastColumn()).getValues();
    values.forEach((rowValues) => {
      const row = buildRowObject_(headers, rowValues);
      const email = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
      if (!email) return;
      if (!bySeller[email]) {
        bySeller[email] = {
          email: email,
          name: clean_(row['Seller Name']),
          listing_count: 0,
          trusted: trusted.has(email),
        };
      }
      bySeller[email].listing_count++;
      // Prefer a non-empty seller name if we encounter one later.
      if (!bySeller[email].name && clean_(row['Seller Name'])) {
        bySeller[email].name = clean_(row['Seller Name']);
      }
    });
  }

  // Include emails that are trusted but have no listings yet (rare).
  trusted.forEach((email) => {
    if (!bySeller[email]) {
      bySeller[email] = { email: email, name: '', listing_count: 0, trusted: true };
    }
  });

  return Object.values(bySeller).sort((a, b) => {
    // Trusted first, then by name.
    if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
    return String(a.name || a.email).localeCompare(String(b.name || b.email));
  });
}

// ---------------------------------------------------------------------------
// Catalog rebuild dispatch — debounced / coalesced.
//
// Old behavior: every approval immediately POSTed a repository_dispatch to
// GitHub. Approving N listings in quick succession kicked off N concurrent
// builds, where the second build's `git push` to gh-pages collided with the
// first, marking earlier runs as failed.
//
// New behavior: each call to triggerCatalogRebuild_ marks a rebuild as
// "pending" and ensures exactly one one-shot time-based trigger is scheduled
// REBUILD_DEBOUNCE_SECONDS in the future. Subsequent calls within that window
// are no-ops (they just append to the reasons log). When the trigger fires,
// performScheduledCatalogRebuild() does the actual GitHub dispatch.
//
// Defaults to 120s (2 min). Override at runtime by setting the script
// property REBUILD_DEBOUNCE_SECONDS — no redeploy needed.
//
// Belt-and-suspenders: the GitHub Actions workflow should also have
//   concurrency:
//     group: catalog-rebuild
//     cancel-in-progress: true
// to handle the rare case where two dispatches still arrive close together.
// ---------------------------------------------------------------------------

const REBUILD_DEBOUNCE_SECONDS_DEFAULT = 120;
const REBUILD_DEBOUNCE_HANDLER = 'performScheduledCatalogRebuild';

function getRebuildDebounceMs_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('REBUILD_DEBOUNCE_SECONDS');
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 30 && n <= 900) return n * 1000;
  } catch (_) {}
  return REBUILD_DEBOUNCE_SECONDS_DEFAULT * 1000;
}

function triggerCatalogRebuild_(reason) {
  try {
    const props = PropertiesService.getScriptProperties();

    // Always mark a rebuild as pending and append the reason (capped to last
    // ~2KB so this property can't grow unbounded).
    props.setProperty('REBUILD_PENDING', '1');
    const existing = props.getProperty('REBUILD_REASONS') || '';
    const next = (existing ? existing + ' | ' : '') + (reason || 'admin_action');
    props.setProperty('REBUILD_REASONS', next.length > 2000 ? next.slice(-2000) : next);

    // If a one-shot trigger is already scheduled and still in the future,
    // coalesce — don't schedule another.
    const existingScheduledIso = props.getProperty('REBUILD_TRIGGER_SCHEDULED_AT');
    if (existingScheduledIso) {
      const existingMs = new Date(existingScheduledIso).getTime();
      if (Number.isFinite(existingMs) && existingMs > Date.now()) {
        Logger.log('triggerCatalogRebuild_: dispatch already scheduled at '
          + existingScheduledIso + ' — coalescing reason="' + reason + '"');
        return;
      }
    }

    // Otherwise, install a fresh one-shot trigger.
    cleanupRebuildTriggers_();
    const triggerAt = new Date(Date.now() + getRebuildDebounceMs_());
    ScriptApp.newTrigger(REBUILD_DEBOUNCE_HANDLER)
      .timeBased()
      .at(triggerAt)
      .create();
    props.setProperty('REBUILD_TRIGGER_SCHEDULED_AT', triggerAt.toISOString());
    Logger.log('triggerCatalogRebuild_: scheduled dispatch for '
      + triggerAt.toISOString() + ' (reason="' + reason + '")');
  } catch (err) {
    Logger.log('triggerCatalogRebuild_ error: ' + (err && err.message ? err.message : err));
  }
}

// Trigger handler — must be a public (non-underscored) function so Apps
// Script's scheduler can invoke it.
// ============================================================================
// Daily renewal check — moves stale listings to "not_renewed" and sends
// warning + expiration emails. Installed via setupDailyRenewalTrigger().
// ============================================================================

function dailyRenewalCheck() {
  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  if (!colMap['last_renewed_at'] || !colMap['status']) {
    Logger.log('dailyRenewalCheck: required columns missing, skipping.');
    return;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();
  const expirationCutoffDays = RENEWAL_WINDOW_DAYS;
  const warningCutoffDays = RENEWAL_WINDOW_DAYS - RENEWAL_WARNING_DAYS;

  // Group changes per seller for batched emails. Key: lowercase email.
  // Each entry: { email, name, expired: [], warning: [] }.
  const perSeller = {};

  function bucket(email, name) {
    const key = clean_(email).toLowerCase();
    if (!key) return null;
    if (!perSeller[key]) {
      perSeller[key] = { email: key, name: clean_(name), expired: [], warning: [] };
    }
    if (!perSeller[key].name && clean_(name)) perSeller[key].name = clean_(name);
    return perSeller[key];
  }

  let demotedCount = 0;
  let warnedCount = 0;
  let initializedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const row = buildRowObject_(headers, values[i]);
    const status = clean_(row['status']).toLowerCase();
    if (!isExpirable_(status)) continue;

    // Lazy-initialize last_renewed_at if missing — don't punish legacy listings
    // that predate this feature on day 1.
    if (!clean_(row['last_renewed_at'])) {
      sheet.getRange(rowNumber, colMap['last_renewed_at']).setValue(now);
      initializedCount++;
      continue;
    }

    const days = daysSinceRenewal_(row);
    if (days === null) continue;

    const sellerEmail = clean_(row[SELLER_EMAIL_COLUMN]);
    const sellerName = clean_(row['Seller Name']);
    const listingTitle = clean_(row['Artwork Title']) || clean_(row['listing_id']);
    const artistName = clean_(row['Artist Name']);
    const display = artistName
      ? `${artistName} — ${listingTitle}`
      : listingTitle;

    if (days >= expirationCutoffDays) {
      // Demote this listing
      sheet.getRange(rowNumber, colMap['status']).setValue('not_renewed');
      if (colMap['updated_at']) {
        sheet.getRange(rowNumber, colMap['updated_at']).setValue(now);
      }
      demotedCount++;
      const b = bucket(sellerEmail, sellerName);
      if (b) b.expired.push(display);
      continue;
    }

    if (days >= warningCutoffDays) {
      const warningSentRaw = row['renewal_warning_sent_at'];
      const warningSent = warningSentRaw
        ? new Date(warningSentRaw)
        : null;
      const lastRenewedRaw = row['last_renewed_at'];
      const lastRenewed = lastRenewedRaw
        ? new Date(lastRenewedRaw)
        : null;

      // Only send a warning once per renewal cycle: if the warning timestamp
      // is older than the current last_renewed_at (i.e. the cycle restarted),
      // we send again.
      const needsWarning =
        !warningSent ||
        isNaN(warningSent.getTime()) ||
        (lastRenewed && !isNaN(lastRenewed.getTime()) && warningSent < lastRenewed);

      if (needsWarning) {
        if (colMap['renewal_warning_sent_at']) {
          sheet.getRange(rowNumber, colMap['renewal_warning_sent_at']).setValue(now);
        }
        warnedCount++;
        const b = bucket(sellerEmail, sellerName);
        if (b) b.warning.push({ display: display, daysLeft: expirationCutoffDays - days });
      }
    }
  }

  SpreadsheetApp.flush();

  // Send batched emails per seller — at most one warning email and one
  // expiration email per seller per run.
  Object.keys(perSeller).forEach(key => {
    const s = perSeller[key];
    if (s.expired.length) {
      sendRenewalExpirationEmail_(s.email, s.name, s.expired);
    }
    if (s.warning.length) {
      sendRenewalWarningEmail_(s.email, s.name, s.warning);
    }
  });

  Logger.log(
    'dailyRenewalCheck: demoted=' + demotedCount +
    ', warned=' + warnedCount +
    ', initialized=' + initializedCount +
    ', sellersNotified=' + Object.keys(perSeller).length
  );

  if (demotedCount > 0) {
    triggerCatalogRebuild_('renewal_demote:' + demotedCount);
  }
}

function sendRenewalWarningEmail_(toEmail, sellerName, warningEntries) {
  if (!toEmail) return;
  const greeting = sellerName ? `Hi ${sellerName},` : 'Hi there,';
  const portalUrl = SELLER_PORTAL_BASE_URL || '';

  // Pick the shortest daysLeft among the warning batch as the headline number.
  const minDaysLeft = warningEntries.reduce(
    (acc, e) => Math.min(acc, e.daysLeft),
    Number.MAX_SAFE_INTEGER
  );

  const list = warningEntries
    .map(e => `  • ${e.display} — ${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'} until expiration`)
    .join('\n');

  const subject = `Action needed: ${warningEntries.length} Canvas Circle listing${warningEntries.length === 1 ? '' : 's'} expiring soon`;
  const body = [
    greeting,
    '',
    `You have ${warningEntries.length} listing${warningEntries.length === 1 ? '' : 's'} that will be moved to "Not Renewed" status in ${minDaysLeft} day${minDaysLeft === 1 ? '' : 's'} unless you renew.`,
    '',
    'Listings expiring soon:',
    list,
    '',
    'To renew them all in one click, open your seller portal:',
    portalUrl,
    '',
    'Renewing keeps your listings live on canvascircle.art. If you no longer want a listing visible, you can also mark it Sold or Delisted from the seller portal.',
    '',
    '— Canvas Circle',
  ].join('\n');

  try {
    MailApp.sendEmail({
      to: toEmail,
      subject: subject,
      body: body,
      name: 'Canvas Circle',
    });
  } catch (err) {
    Logger.log('sendRenewalWarningEmail_ failed for ' + toEmail + ': ' + (err && err.message ? err.message : err));
  }
}

function sendRenewalExpirationEmail_(toEmail, sellerName, listingTitles) {
  if (!toEmail) return;
  const greeting = sellerName ? `Hi ${sellerName},` : 'Hi there,';
  const portalUrl = SELLER_PORTAL_BASE_URL || '';

  const list = listingTitles.map(t => `  • ${t}`).join('\n');

  const subject = `${listingTitles.length} Canvas Circle listing${listingTitles.length === 1 ? '' : 's'} moved to "Not Renewed"`;
  const body = [
    greeting,
    '',
    `${listingTitles.length} of your listings haven't been updated in ${RENEWAL_WINDOW_DAYS} days, so we moved them to "Not Renewed" status. They've been hidden from the public catalog, but the listing data is preserved — you can renew anytime to bring them back.`,
    '',
    'Listings affected:',
    list,
    '',
    'Renew them in one click from your seller portal:',
    portalUrl,
    '',
    'Renewing flips them back to "Available" and republishes them on canvascircle.art.',
    '',
    '— Canvas Circle',
  ].join('\n');

  try {
    MailApp.sendEmail({
      to: toEmail,
      subject: subject,
      body: body,
      name: 'Canvas Circle',
    });
  } catch (err) {
    Logger.log('sendRenewalExpirationEmail_ failed for ' + toEmail + ': ' + (err && err.message ? err.message : err));
  }
}

// One-time setup. Run this manually from the Apps Script editor after
// deploying. Idempotent — clears any prior renewal trigger before installing.
function setupDailyRenewalTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyRenewalCheck') {
      try { ScriptApp.deleteTrigger(t); } catch (_) {}
    }
  });
  ScriptApp.newTrigger('dailyRenewalCheck')
    .timeBased()
    .atHour(7) // ~7 AM in the script's timezone — well before peak browsing
    .everyDays(1)
    .create();
  Logger.log('Daily renewal check trigger installed at hour 7.');
}

function performScheduledCatalogRebuild() {
  const props = PropertiesService.getScriptProperties();

  // Always clean up the trigger that just fired (and any stragglers) before
  // touching state, so a crash here can't leave a phantom trigger queued.
  cleanupRebuildTriggers_();
  props.deleteProperty('REBUILD_TRIGGER_SCHEDULED_AT');

  if (!props.getProperty('REBUILD_PENDING')) {
    Logger.log('performScheduledCatalogRebuild: nothing pending, no-op.');
    return;
  }

  const reasons = props.getProperty('REBUILD_REASONS') || 'admin_action';
  const ok = doDispatchToGitHub_(reasons);

  if (ok) {
    props.deleteProperty('REBUILD_PENDING');
    props.deleteProperty('REBUILD_REASONS');
  } else {
    // Leave REBUILD_PENDING set and reschedule a retry via the same coalesce
    // path. This means transient GitHub failures don't drop the rebuild.
    Logger.log('performScheduledCatalogRebuild: dispatch failed, rescheduling.');
    triggerCatalogRebuild_('retry_after_failure');
  }
}

function triggerManualCatalogRebuild() {
  // Admin "Update Catalog" button — immediate, non-debounced dispatch.
  if (!isAdminUser_()) {
    throw new Error('Not authorized.');
  }

  const props = PropertiesService.getScriptProperties();
  const token = clean_(props.getProperty('GITHUB_PAT'));
  const repo = clean_(props.getProperty('GITHUB_REPO'));

  if (!token || !repo) {
    return {
      dispatched: false,
      message: 'GITHUB_PAT or GITHUB_REPO script property is not set.',
    };
  }

  const ok = doDispatchToGitHub_('manual_admin_button');

  if (ok) {
    // Clear any pending debounced rebuild — we just sent one immediately,
    // no need for a scheduled trigger to fire again shortly after.
    props.deleteProperty('REBUILD_PENDING');
    props.deleteProperty('REBUILD_REASONS');
    cleanupRebuildTriggers_();
    props.deleteProperty('REBUILD_TRIGGER_SCHEDULED_AT');
    return { dispatched: true };
  }

  return {
    dispatched: false,
    message: 'GitHub returned a non-2xx response — check the Apps Script executions log for the HTTP code.',
  };
}

function cleanupRebuildTriggers_() {
  try {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === REBUILD_DEBOUNCE_HANDLER) {
        try { ScriptApp.deleteTrigger(t); } catch (_) {}
      }
    });
  } catch (err) {
    Logger.log('cleanupRebuildTriggers_ error: ' + (err && err.message ? err.message : err));
  }
}

// Performs the actual repository_dispatch HTTP call. Returns true on 2xx,
// false otherwise. No state mutation here — caller decides what to do on
// failure.
function doDispatchToGitHub_(reason) {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = clean_(props.getProperty('GITHUB_PAT'));
    const repo = clean_(props.getProperty('GITHUB_REPO'));

    if (!token || !repo) {
      Logger.log('doDispatchToGitHub_: GITHUB_PAT or GITHUB_REPO not configured; skipping dispatch.');
      // Treat as success so we don't keep rescheduling forever in a misconfigured project.
      return true;
    }

    const url = 'https://api.github.com/repos/' + repo + '/dispatches';
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      payload: JSON.stringify({
        event_type: 'rebuild-catalog',
        client_payload: {
          reason: reason || 'admin_action',
          triggered_at: new Date().toISOString(),
        },
      }),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('doDispatchToGitHub_: dispatch sent (HTTP ' + code + ', reason="' + reason + '")');
      return true;
    }
    Logger.log('doDispatchToGitHub_: dispatch failed HTTP ' + code + ' - ' + response.getContentText());
    return false;
  } catch (err) {
    Logger.log('doDispatchToGitHub_ error: ' + (err && err.message ? err.message : err));
    return false;
  }
}

// One-time setup: run this manually from the Apps Script editor after
// deploying the rebuild-debounce changes. It touches ScriptApp.* APIs so
// Apps Script prompts for the new OAuth scope (script.scriptapp) — without
// this, the first auto-scheduled trigger would fail because web-app
// invocations can't trigger consent screens. Returns the current
// scheduler state so you can confirm everything's wired up.
function setupRebuildScheduler() {
  if (!isAdminUser_()) throw new Error('Not authorized.');
  cleanupRebuildTriggers_();
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    debounceSeconds: getRebuildDebounceMs_() / 1000,
    pending: !!props.getProperty('REBUILD_PENDING'),
    scheduledAt: props.getProperty('REBUILD_TRIGGER_SCHEDULED_AT') || null,
    githubConfigured: !!(clean_(props.getProperty('GITHUB_PAT')) && clean_(props.getProperty('GITHUB_REPO'))),
  };
}

// Admin escape hatch: force an immediate dispatch, ignoring the debounce
// timer. Useful if you ever need to push out a catalog change RIGHT NOW.
// Also runs the scheduled rebuild if one is queued.
function forceCatalogRebuildNow() {
  if (!isAdminUser_()) throw new Error('Not authorized.');
  const props = PropertiesService.getScriptProperties();
  cleanupRebuildTriggers_();
  props.deleteProperty('REBUILD_TRIGGER_SCHEDULED_AT');
  const reasons = props.getProperty('REBUILD_REASONS') || 'manual_force';
  const ok = doDispatchToGitHub_(reasons);
  if (ok) {
    props.deleteProperty('REBUILD_PENDING');
    props.deleteProperty('REBUILD_REASONS');
  }
  return { ok: ok };
}

function fetchCompressedImageBlob_(sourceFileId) {
  // Fetch a downsized JPEG of a publicly-shared Drive file via its thumbnail URL.
  // Drive sometimes needs a few seconds to generate the thumbnail for a fresh upload,
  // so retry with backoff. Returns a Blob on success, null on failure.
  if (!sourceFileId) return null;

  const thumbnailUrl =
    'https://drive.google.com/thumbnail?id=' + sourceFileId +
    '&sz=w' + COMPRESSED_IMAGE_MAX_WIDTH;

  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = UrlFetchApp.fetch(thumbnailUrl, {
        muteHttpExceptions: true,
        followRedirects: true,
      });

      if (response.getResponseCode() === 200) {
        const blob = response.getBlob();
        // A real thumbnail is at least a few KB. Smaller responses are usually
        // Drive's "icon" placeholder (broken-file glyph) or a transient error.
        if (blob.getBytes().length > 2000) {
          return blob;
        }
      }
    } catch (err) {
      Logger.log(
        'fetchCompressedImageBlob_ attempt ' + (attempt + 1) +
        ' error: ' + (err && err.message ? err.message : err)
      );
    }

    if (attempt < maxAttempts - 1) {
      Utilities.sleep(1500 * (attempt + 1)); // 1.5s, 3s, 4.5s
    }
  }

  return null;
}

function compressOrFallback_(tempFile, listingId, outputFolder, sourceExtension) {
  // tempFile must already be a Drive file in outputFolder with public sharing set.
  // On success: writes the compressed thumbnail as <listingId>.jpg, trashes tempFile.
  // On failure: renames tempFile to <listingId>.<sourceExtension> as a full-size fallback.
  // Returns the same shape the original copy/save helpers used so callers don't change.

  const compressedBlob = fetchCompressedImageBlob_(tempFile.getId());

  if (compressedBlob) {
    const finalName = listingId + '.jpg';

    let existingFiles = outputFolder.getFilesByName(finalName);
    while (existingFiles.hasNext()) {
      existingFiles.next().setTrashed(true);
    }

    compressedBlob.setName(finalName);
    compressedBlob.setContentType('image/jpeg');

    const finalFile = outputFolder.createFile(compressedBlob);
    finalFile.setName(finalName);
    finalFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    tempFile.setTrashed(true);

    return {
      sourceImageUrl: 'https://drive.google.com/open?id=' + finalFile.getId(),
      imageFileName: finalName,
      copiedFileId: finalFile.getId(),
    };
  }

  Logger.log(
    'compressOrFallback_: compression failed for ' + listingId +
    '; keeping full-size file.'
  );

  const fallbackName = listingId + '.' + sourceExtension;

  const existingFiles = outputFolder.getFilesByName(fallbackName);
  while (existingFiles.hasNext()) {
    const f = existingFiles.next();
    if (f.getId() !== tempFile.getId()) {
      f.setTrashed(true);
    }
  }

  tempFile.setName(fallbackName);

  return {
    sourceImageUrl: 'https://drive.google.com/open?id=' + tempFile.getId(),
    imageFileName: fallbackName,
    copiedFileId: tempFile.getId(),
  };
}
// trigger function
function onFormSubmitProcessArtwork(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    processArtworkSubmissions();
  } finally {
    lock.releaseLock();
  }
} 

function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w]/g, '');
}


function getAdminListings() {
  if (!isAdminUser_()) {
    throw new Error('Not authorized.');
  }

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  const listings = [];

  values.forEach((rowValues, index) => {
    const row = buildRowObject_(headers, rowValues);

    const rawImageUrl =
      clean_(row['source_image_url']) ||
      clean_(row[UPLOAD_IMAGE_COLUMN]);

    listings.push({
      listing_id: clean_(row['listing_id']),
      artwork_title: clean_(row['Artwork Title']),
      artist_name: clean_(row['Artist Name']),
      medium: clean_(row['Medium/Type']),
      artwork_category: normalizeArtworkCategory_(row[ARTWORK_CATEGORY_COLUMN]),
      artwork_size_inches: clean_(row['Artwork Size (inches)']),
      framed_size_inches: clean_(row['Framed Size (inches)']),
      price_usd: clean_(row['Price (USD)']),
      shipping_included: normalizeYesNoText_(row[SHIPPING_COLUMN]),
      certificate_of_authenticity_included: normalizeYesNoText_(row[COA_COLUMN]),
      seller_name: clean_(row['Seller Name']),
      seller_email: clean_(row[SELLER_EMAIL_COLUMN]),
      seller_profile_url: clean_(row[SELLER_PROFILE_URL_COLUMN]) || clean_(row[SELLER_PROFILE_COLUMN]),
      seller_notes: clean_(row[SELLER_NOTES_COLUMN]),
      seller_location: clean_(row['seller_location']),
      status: normalizeStatus_(row['status']) || 'available',
      moderation_status: clean_(row['moderation_status']) || 'pending_review',
      source_image_url: buildDisplayImageUrl_(rawImageUrl),
      updated_at: formatDateIsoMaybe_(row['updated_at']),
    });
  });

  return listings;
}

// Admin endpoint: returns the searchable list of every known seller along
// with their trusted state and listing count.
function getAdminTrustedSellersData() {
  if (!isAdminUser_()) throw new Error('Not authorized.');
  return getKnownSellersWithTrust_();
}

// Admin endpoint: toggles a seller's trusted state. Returns the refreshed
// list so the UI can re-render in one round trip.
function getExpiringListingsAdmin() {
  // Admin endpoint: lists every available/pending listing (and currently
  // not_renewed listings) annotated with days-since-renewal, grouped by seller.
  if (!isAdminUser_()) {
    throw new Error('Not authorized.');
  }

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sellers: [], renewalWindowDays: RENEWAL_WINDOW_DAYS, renewalWarningDays: RENEWAL_WARNING_DAYS };

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const bySeller = {};

  values.forEach(rowValues => {
    const row = buildRowObject_(headers, rowValues);
    const status = clean_(row['status']).toLowerCase();
    if (!isRenewableStatus_(status)) return; // Skip sold/delisted

    const email = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
    if (!email) return;

    const days = daysSinceRenewal_(row);
    const daysUntilExpiration = days === null
      ? RENEWAL_WINDOW_DAYS
      : Math.max(0, RENEWAL_WINDOW_DAYS - days);

    if (!bySeller[email]) {
      bySeller[email] = {
        email: email,
        name: clean_(row['Seller Name']),
        listings: [],
      };
    }
    if (!bySeller[email].name && clean_(row['Seller Name'])) {
      bySeller[email].name = clean_(row['Seller Name']);
    }

    bySeller[email].listings.push({
      listing_id: clean_(row['listing_id']),
      artist_name: clean_(row['Artist Name']),
      artwork_title: clean_(row['Artwork Title']),
      status: status,
      daysSinceRenewal: days === null ? 0 : days,
      daysUntilExpiration: status === 'not_renewed' ? 0 : daysUntilExpiration,
    });
  });

  // Sort listings within each seller by days-until-expiration ascending
  // (most-urgent first), then sort sellers by their most-urgent listing.
  const sellers = Object.values(bySeller);
  sellers.forEach(s => {
    s.listings.sort((a, b) => a.daysUntilExpiration - b.daysUntilExpiration);
    s.minDaysUntilExpiration = s.listings.length
      ? s.listings[0].daysUntilExpiration
      : RENEWAL_WINDOW_DAYS;
    s.notRenewedCount = s.listings.filter(l => l.status === 'not_renewed').length;
    s.expiringSoonCount = s.listings.filter(
      l => l.status !== 'not_renewed' && l.daysUntilExpiration <= RENEWAL_WARNING_DAYS
    ).length;
  });
  sellers.sort((a, b) => a.minDaysUntilExpiration - b.minDaysUntilExpiration);

  return {
    sellers: sellers,
    renewalWindowDays: RENEWAL_WINDOW_DAYS,
    renewalWarningDays: RENEWAL_WARNING_DAYS,
  };
}

function extendRenewalForSellerAdmin(email) {
  // Admin endpoint: refresh the renewal clock for every available/pending/
  // not_renewed listing owned by the seller with this email. Effectively a
  // manual renewal on their behalf — useful when a seller is on vacation /
  // temporarily unavailable.
  if (!isAdminUser_()) {
    throw new Error('Not authorized.');
  }

  email = clean_(email).toLowerCase();
  if (!email) {
    throw new Error('Missing seller email.');
  }

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('No listings found.');
  }
  if (!colMap['last_renewed_at']) {
    throw new Error('last_renewed_at column missing from sheet.');
  }

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();
  let renewedCount = 0;
  let revivedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const row = buildRowObject_(headers, values[i]);
    const rowEmail = clean_(row[SELLER_EMAIL_COLUMN]).toLowerCase();
    if (rowEmail !== email) continue;

    const status = clean_(row['status']).toLowerCase();
    if (!isRenewableStatus_(status)) continue;

    sheet.getRange(rowNumber, colMap['last_renewed_at']).setValue(now);
    if (colMap['renewal_warning_sent_at']) {
      sheet.getRange(rowNumber, colMap['renewal_warning_sent_at']).clearContent();
    }
    if (status === 'not_renewed') {
      sheet.getRange(rowNumber, colMap['status']).setValue('available');
      revivedCount++;
    }
    if (colMap['updated_at']) {
      sheet.getRange(rowNumber, colMap['updated_at']).setValue(now);
    }
    renewedCount++;
  }

  if (!renewedCount) {
    throw new Error('No renewable listings found for ' + email);
  }

  SpreadsheetApp.flush();
  triggerCatalogRebuild_('admin_extend_renewal:' + email);

  return {
    email: email,
    renewedCount: renewedCount,
    revivedCount: revivedCount,
    renewedAt: now.toISOString(),
  };
}

function setSellerTrustedAdmin(email, name, trusted) {
  if (!isAdminUser_()) throw new Error('Not authorized.');
  setSellerTrusted_(email, name, !!trusted);
  return getKnownSellersWithTrust_();
}

// Admin endpoint: returns the count of distinct seller emails currently on
// file plus the remaining daily mail quota. The admin portal calls this
// before a broadcast so the user can see "Send to N sellers (Q quota left)"
// without spending a round trip on getKnownSellersWithTrust_.
function getBroadcastEmailPreview() {
  if (!isAdminUser_()) throw new Error('Not authorized.');
  const sellers = getKnownSellersWithTrust_();
  const recipients = sellers.map(s => s.email).filter(Boolean);
  let quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (_) {}
  return {
    recipientCount: recipients.length,
    remainingQuota: quota,
  };
}

// Admin endpoint: send a broadcast email to every distinct seller email on
// file. Each seller receives an individual message (not a BCC blast) so
// nobody sees other sellers' addresses. Plain-text body is sent alongside
// an HTML version where newlines become <br> so paragraph spacing is
// preserved across email clients.
//
// Hard limits:
//   - Apps Script web-app calls cap at 6 minutes total runtime, so very
//     large lists may time out partway. We iterate in order and report
//     how many were sent before the timeout so the admin knows to retry
//     against the remainder.
//   - Daily quota check happens up front; if the broadcast would exceed
//     the remaining quota for the day, we refuse instead of sending a
//     partial batch.
function sendBroadcastEmail(payload) {
  if (!isAdminUser_()) throw new Error('Not authorized.');

  const subject = clean_(payload && payload.subject);
  const body = clean_(payload && payload.body);
  if (!subject) throw new Error('Subject is required.');
  if (!body) throw new Error('Message body is required.');

  const sellers = getKnownSellersWithTrust_();
  const recipients = sellers.map(s => s.email).filter(Boolean);
  if (!recipients.length) throw new Error('No seller emails on file.');

  let remainingQuota = -1;
  try { remainingQuota = MailApp.getRemainingDailyQuota(); } catch (_) {}
  if (remainingQuota >= 0 && recipients.length > remainingQuota) {
    throw new Error(
      'Daily email quota too low: would send ' + recipients.length +
      ' but only ' + remainingQuota + ' emails remain in today\'s quota. ' +
      'Try again tomorrow, or split this into smaller batches.'
    );
  }

  const htmlBody =
    '<div style="font-family:Arial,sans-serif;line-height:1.55;color:#1f1a17;max-width:640px;">' +
    escapeHtml_(body).replace(/\n/g, '<br>') +
    '<p style="margin-top:28px;color:#6f675e;font-size:13px;">— The Canvas Circle team</p>' +
    '</div>';

  const plainBody = body + '\n\n— The Canvas Circle team';

  let sent = 0;
  const failures = [];

  for (let i = 0; i < recipients.length; i++) {
    const email = recipients[i];
    try {
      MailApp.sendEmail({
        to: email,
        subject: subject,
        body: plainBody,
        htmlBody: htmlBody,
        name: EMAIL_FROM_NAME,
      });
      sent++;
    } catch (err) {
      failures.push({ email: email, message: (err && err.message) || String(err) });
    }
  }

  return {
    total: recipients.length,
    sent: sent,
    failed: failures.length,
    failures: failures.slice(0, 10), // cap so the response stays small
  };
}

function updateModerationStatus(listingId, status) {
  if (!isAdminUser_()) {
    throw new Error('Not authorized.');
  }

  // ✅ Validate input
  const allowed = ["pending_review", "approved", "rejected"];
  if (!allowed.includes(status)) {
    throw new Error("Invalid status");
  }

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    throw new Error("No listings found");
  }

  // Get all rows
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (let i = 0; i < values.length; i++) {
    const row = buildRowObject_(headers, values[i]);

    if (clean_(row['listing_id']) === String(listingId)) {
      const rowNumber = i + 2;

      // ✅ Update moderation status
      if (colMap['moderation_status']) {
        sheet.getRange(rowNumber, colMap['moderation_status']).setValue(status);
      }

      // ✅ Update timestamp (nice to have)
      if (colMap['updated_at']) {
        sheet.getRange(rowNumber, colMap['updated_at']).setValue(new Date());
      }

      SpreadsheetApp.flush();

      triggerCatalogRebuild_('moderation_status:' + status + ':' + listingId);

      return true;
    }
  }

  throw new Error("Listing not found");
}

// Admin endpoint: reinstate a listing that was "removed from seller portal"
// (status='delisted'). Sets the listing's status back to 'available' and
// queues a debounced catalog rebuild. Moderation status is left as-is —
// admin can separately approve/reject via updateModerationStatus.
function reinstateListing(listingId) {
  if (!isAdminUser_()) throw new Error('Not authorized.');

  const sheet = getListingsSheet_();
  const headers = ensureRequiredColumns_(sheet);
  const colMap = getColumnMap_(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No listings found.');

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < values.length; i++) {
    const row = buildRowObject_(headers, values[i]);
    if (clean_(row['listing_id']) === String(listingId)) {
      const rowNumber = i + 2;
      if (colMap['status']) {
        sheet.getRange(rowNumber, colMap['status']).setValue('available');
      }
      if (colMap['updated_at']) {
        sheet.getRange(rowNumber, colMap['updated_at']).setValue(new Date());
      }
      SpreadsheetApp.flush();
      triggerCatalogRebuild_('reinstate:' + listingId);
      return true;
    }
  }
  throw new Error('Listing not found');
}
import csv
import html
import os
import re
import urllib.request
from datetime import datetime
from pathlib import Path


PRICE_DROP_WINDOW_DAYS = 30

# Public domain + assets used to build absolute URLs in social-preview meta tags.
SITE_URL = "https://canvascircle.art"
SOCIAL_CARD_PATH = "assets/og-image.png"
SITE_NAME = "Canvas Circle"

BUYING_GUIDELINES = [
    "Ask for a video of the artwork they are selling and have them state their name and date in the video as well. If they cannot provide you with that video, then do not proceed with the transaction and please report that member to the admin/moderator team.",
    "Ask the admins and moderators if they know of the seller. One of us may be able to provide you with insight. Also ask the seller if they have any sales references of people that you can contact to ask how their transaction went with the seller.",
    "Always use goods and services via PayPal or Venmo if it is a new seller that has no sales references.",
    "Always obtain shipping insurance for the total purchase price.",
]

SHIPPING_GUIDELINES = [
    "Always obtain shipping insurance for the total purchase price.",
    "For transactions $10,000 and less, UPS through Pirate Ship’s website provides by far the best shipping rates and can fully insure the package for the sale price.",
    "For transactions above $10,000, you will need to seek alternative shipping options to fully insure. We recommend utilizing goshippo.com to find the best shipping rates that will fully cover the transaction cost.",
    "For packaging the art, Park West art boxes are highly recommended since they provide proper spacing and styrofoam corners. You can also use TV boxes from U-Haul, Lowe’s, or Home Depot, but make sure to use packaging materials that provide proper shock absorption protection to the art during shipping. Bubble wrap, packing peanuts, and styrofoam are all good options. Make sure the art itself cannot jostle around in the box.",
    "When packaging, never place any packing materials directly on the canvas itself as you run the risk of damage to the art due to the added weight that can cause the canvas to sag onto its stretcher bars on the back.",
    "Before shipping, take pictures and videos of the art in the packaging as proof of proper packaging. This will help if you need to file a shipping insurance claim if the art gets damaged during shipping. Insurance claims will not go through if you improperly package your art beforehand, so please take the necessary added precautions to ensure you have done this properly. The admin and moderators can provide advice if anyone needs help on packaging.",
    "If the art arrives damaged due to shipping carrier mishandling, do not panic. The receiver or buyer of the art will need to take pictures of the packaging and where the damage on the art has occurred. Do not throw away any of the packaging or ship the damaged art anywhere during the insurance claim process. The insurance claim may ask for the buyer to get a third-party letter stating the art or frame cannot be repaired. Michael’s, Hobby Lobby custom framing, or another art framer may be able to provide this.",
    "For expensive pieces, we also recommend requiring a signature upon delivery. This helps prevent issues from inclement weather and reduces the risk of package theft.",
]


INPUT_TO_OUTPUT = {
    "Timestamp": "processed_at",
    "Seller Name": "seller_name",
    "Artist Name": "artist_name",
    "Artwork Title": "artwork_title",
    "Medium/Type": "medium",
    "Is this artwork a unique/original or limited edition?": "artwork_category",
    "Artwork Size (inches)": "artwork_size_inches",
    "Framed Size (inches)": "framed_size_inches",
    "Price (USD)": "price",
    "Shipping Included?": "shipping_included",
    "Certificate of Authenticity Included?": "certificate_of_authenticity_included",
    "Seller Notes/ Description": "seller_notes",
    "Seller Notes/ Description ": "seller_notes",
    "Upload Artwork Image (ONE image per submission)": "source_image_url",
    "Link to Seller Facebook Profile (Make sure your link works before submitting as this link will be on each of your listings for potential buyers to contact you!)": "seller_profile_url",
    "Seller Email Address (gmail preferred)": "seller_email",
    "seller_location": "seller_location",

    "listing_id": "listing_id",
    "image_file": "image_file",
    "source_image_url": "source_image_url",
    "status": "status",
    "seller_token": "seller_token",
    "updated_at": "updated_at",
    "previous_price": "previous_price",
    "price_updated_at": "price_updated_at",
    "moderation_status": "moderation_status",
    "seller_profile_url": "seller_profile_url",
    "seller_email": "seller_email",

    "processed_at": "processed_at",
    "seller_name": "seller_name",
    "artist_name": "artist_name",
    "artwork_title": "artwork_title",
    "medium": "medium",
    "artwork_category": "artwork_category",
    "artwork_size_inches": "artwork_size_inches",
    "framed_size_inches": "framed_size_inches",
    "price": "price",
    "shipping_included": "shipping_included",
    "certificate_of_authenticity_included": "certificate_of_authenticity_included",
    "seller_notes": "seller_notes",
    "seller_location": "seller_location",
    "seller_mood": "seller_mood",
}

OUTPUT_COLUMNS = [
    "listing_id",
    "seller_name",
    "seller_email",
    "seller_profile_url",
    "artist_name",
    "artwork_title",
    "medium",
    "artwork_size_inches",
    "framed_size_inches",
    "price",
    "shipping_included",
    "certificate_of_authenticity_included",
    "seller_notes",
    "seller_location",
    "seller_mood",
    "image_file",
    "source_image_url",
    "processed_at",
    "updated_at",
    "previous_price",
    "price_updated_at",
    "status",
    "moderation_status",
]


def clean(value):
    if value is None:
        return ""
    return str(value).strip()


def normalize_bool_text(value):
    value = clean(value)
    if not value:
        return ""

    lower = value.lower()

    if lower in {"yes", "y", "true", "1"}:
        return "TRUE"

    if lower in {"no", "n", "false", "0"}:
        return "FALSE"

    return ""


def normalize_artwork_category(value):
    value = clean(value)
    if not value:
        return ""

    normalized = value.lower().replace(" ", "").replace("-", "").replace("_", "")

    if "limited" in normalized:
        return "Limited Edition"

    if "unique" in normalized or "original" in normalized:
        return "Unique/Original"

    return value


def normalize_price(value):
    value = clean(value)
    if not value:
        return ""

    cleaned = value.replace("$", "").replace(",", "").strip()
    try:
        number = float(cleaned)
    except ValueError:
        return value

    if number.is_integer():
        return str(int(number))
    return f"{number:.2f}"


def normalize_row(row, index):
    converted = {col: "" for col in OUTPUT_COLUMNS}

    for src_col, dest_col in INPUT_TO_OUTPUT.items():
        if src_col in row and clean(row[src_col]):
            converted[dest_col] = clean(row[src_col])

    if not converted["listing_id"]:
        converted["listing_id"] = f"listing_{index:04d}"

    if not converted["image_file"]:
        converted["image_file"] = f"{converted['listing_id']}.jpg"

    if not converted["status"]:
        converted["status"] = "available"

    if not converted["source_image_url"]:
        converted["source_image_url"] = clean(
            row.get("Upload Artwork Image (ONE image per submission)", "")
        )

    converted["shipping_included"] = normalize_bool_text(converted["shipping_included"])
    converted["certificate_of_authenticity_included"] = normalize_bool_text(
        converted["certificate_of_authenticity_included"]
    )
    converted["price"] = normalize_price(converted["price"])
    converted["artwork_category"] = normalize_artwork_category(converted["artwork_category"])

    return converted


def is_public_listing(row):
    moderation_status = clean(row.get("moderation_status")).lower()
    listing_status = clean(row.get("status")).lower()

    if moderation_status != "approved":
        return False

    return listing_status in {"available", "pending"}


def load_csv_rows_from_path(csv_path):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_csv_rows_from_url(url):
    with urllib.request.urlopen(url) as response:
        raw = response.read()

    text = raw.decode("utf-8-sig")
    return list(csv.DictReader(text.splitlines()))


def build_google_sheet_csv_url(sheet_id, gid="0"):
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"


def load_data(source):
    if str(source).startswith(("http://", "https://")):
        rows = load_csv_rows_from_url(source)
    else:
        rows = load_csv_rows_from_path(source)

    normalized_rows = []
    for i, row in enumerate(rows, start=1):
        normalized = normalize_row(row, i)
        normalized["_row_index"] = i - 1
        if is_public_listing(normalized):
            normalized_rows.append(normalized)

    return normalized_rows


def parse_price(value):
    if value in (None, "", "None"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def format_price(value):
    price = parse_price(value)
    if price is None:
        return "Price on request"
    if price.is_integer():
        return f"${int(price):,}"
    return f"${price:,.2f}"


def is_price_drop(row):
    current_price = parse_price(row.get("price"))
    previous_price = parse_price(row.get("previous_price"))

    if current_price is None or previous_price is None:
        return False

    if previous_price <= current_price:
        return False

    price_updated_at = parse_datetime(row.get("price_updated_at"))
    if price_updated_at is None:
        return True

    if price_updated_at.tzinfo:
        age_days = (datetime.now(price_updated_at.tzinfo) - price_updated_at).days
    else:
        age_days = (datetime.now() - price_updated_at).days

    return age_days <= PRICE_DROP_WINDOW_DAYS


def build_price_html(row):
    current_display = format_price(row.get("price"))

    if not is_price_drop(row):
        return f'<div class="price">{safe_text(current_display)}</div>'

    previous_display = format_price(row.get("previous_price"))

    return f"""
                <div class="price price-drop-price">
                    <span class="price-drop-label">Price Drop</span>
                    <span class="price-stack">
                        <span class="old-price">{safe_text(previous_display)}</span>
                        <span class="new-price">{safe_text(current_display)}</span>
                    </span>
                </div>
    """


def parse_bool(value):
    if value in (True, False):
        return value
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in ("1", "true", "yes"):
        return True
    if s in ("0", "false", "no"):
        return False
    return None


def parse_datetime(value):
    if not value:
        return None

    text = str(value).strip()
    if not text:
        return None

    formats = [
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        # Google Forms exports the Timestamp column in US format like
        # "1/15/2026 12:34:56" — accept both 12-hour and 24-hour variants.
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def safe_text(value):
    if value is None:
        return ""
    return html.escape(str(value))


def build_meta_tags(page_title: str, description: str, url_path: str = "") -> str:
    """Render Open Graph + Twitter meta tags so URL link previews look right.
    url_path is a relative path like 'about.html' (or empty for the catalog root)."""
    full_url = SITE_URL if not url_path else f"{SITE_URL}/{url_path.lstrip('/')}"
    image_url = f"{SITE_URL}/{SOCIAL_CARD_PATH}"
    return (
        f'    <meta name="description" content="{safe_text(description)}">\n'
        f'    <meta property="og:type" content="website">\n'
        f'    <meta property="og:site_name" content="{safe_text(SITE_NAME)}">\n'
        f'    <meta property="og:url" content="{full_url}">\n'
        f'    <meta property="og:title" content="{safe_text(page_title)}">\n'
        f'    <meta property="og:description" content="{safe_text(description)}">\n'
        f'    <meta property="og:image" content="{image_url}">\n'
        f'    <meta property="og:image:width" content="1200">\n'
        f'    <meta property="og:image:height" content="630">\n'
        f'    <meta name="twitter:card" content="summary_large_image">\n'
        f'    <meta name="twitter:title" content="{safe_text(page_title)}">\n'
        f'    <meta name="twitter:description" content="{safe_text(description)}">\n'
        f'    <meta name="twitter:image" content="{image_url}">'
    )


def extract_drive_file_id(url):
    if not url:
        return ""

    text = str(url).strip()
    patterns = [
        r"/file/d/([a-zA-Z0-9_-]+)",
        r"[?&]id=([a-zA-Z0-9_-]+)",
        r"/open\?id=([a-zA-Z0-9_-]+)",
        r"^([a-zA-Z0-9_-]{20,})$",
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1)

    return ""


def drive_thumbnail_url(url, size="w600"):
    file_id = extract_drive_file_id(url)
    if not file_id:
        return clean(url)
    return f"https://drive.google.com/thumbnail?id={file_id}&sz={size}"


def relative_image_src(output_path: Path, source_dir: Path, filename: str) -> str:
    return f"images/{filename}"


def build_image_src(row, output_path: Path, images_path: Path) -> str:
    source_image_url = clean(row.get("source_image_url"))
    if source_image_url:
        return drive_thumbnail_url(source_image_url)

    image_file = clean(row.get("image_file"))
    if image_file:
        return relative_image_src(output_path, images_path, image_file)

    return ""


def build_badges(row):
    badges = []

    shipping = parse_bool(row.get("shipping_included"))
    coa = parse_bool(row.get("certificate_of_authenticity_included"))
    category = (row.get("artwork_category") or "").strip()
    status = (row.get("status") or "").strip()

    if shipping is True:
        badges.append('<span class="badge">Shipping Included</span>')
    elif shipping is False:
        badges.append('<span class="badge badge-warn">Shipping Extra</span>')

    if coa is True:
        badges.append('<span class="badge">COA Included</span>')
    elif coa is False:
        badges.append('<span class="badge badge-warn">No COA</span>')

    if category:
        badges.append(f'<span class="badge artwork-category-badge">{safe_text(category)}</span>')

    if status:
        status_class = "status-pill"
        status_lower = status.lower()
        if status_lower == "sold":
            status_class += " status-sold"
        elif status_lower == "pending":
            status_class += " status-pending"
        elif status_lower == "available":
            status_class += " status-available"
        badges.append(f'<span class="{status_class}">{safe_text(status)}</span>')

    return "".join(badges)


def listed_for_text(row):
    """Return a friendly 'Listed today / yesterday / N days ago' string from the
    row's processed_at timestamp, or empty string if the timestamp can't be parsed."""
    dt = parse_datetime(row.get("processed_at"))
    if dt is None:
        return ""

    if dt.tzinfo:
        now = datetime.now(dt.tzinfo)
    else:
        now = datetime.now()

    delta_days = (now - dt).days
    if delta_days < 0:
        return ""
    if delta_days == 0:
        return "Listed today"
    if delta_days == 1:
        return "Listed yesterday"
    return f"Listed {delta_days} days ago"


def build_specs(row):
    specs = []

    listed_for = listed_for_text(row)
    medium = (row.get("medium") or "").strip()
    artwork_size = (row.get("artwork_size_inches") or "").strip()
    framed_size = (row.get("framed_size_inches") or "").strip()

    if listed_for:
        specs.append(
            f'<div class="spec-row"><span class="spec-label">Listed</span><span class="spec-value">{safe_text(listed_for)}</span></div>'
        )

    if medium:
        specs.append(
            f'<div class="spec-row"><span class="spec-label">Type</span><span class="spec-value">{safe_text(medium)}</span></div>'
        )

    if artwork_size:
        specs.append(
            f'<div class="spec-row"><span class="spec-label">Artwork Size (Inches)</span><span class="spec-value">{safe_text(artwork_size)}</span></div>'
        )

    if framed_size:
        specs.append(
            f'<div class="spec-row"><span class="spec-label">Framed Size (Inches)</span><span class="spec-value">{safe_text(framed_size)}</span></div>'
        )

    return "".join(specs)


def build_notes(row):
    notes = (row.get("seller_notes") or "").strip()
    if not notes:
        return ""
    return f'<p class="notes">{safe_text(notes)}</p>'


def newest_sort_value(row):
    dt = parse_datetime(row.get("processed_at"))
    if dt is not None:
        return dt.timestamp()
    return float(row.get("_row_index", 0))


def get_price_band(price):
    if price is None:
        return "unknown"
    if price < 1000:
        return "under1000"
    if price <= 2499:
        return "1000to2499"
    if price <= 4999:
        return "2500to4999"
    return "5000plus"


def build_card(row, image_src):
    artist_name_raw = row.get("artist_name") or "Unknown Artist"
    artwork_title_raw = row.get("artwork_title") or "Untitled"
    medium_raw = row.get("medium") or ""
    artwork_category_raw = (row.get("artwork_category") or "").strip()
    seller_name_raw = row.get("seller_name") or ""
    status_raw = row.get("status") or ""
    listing_id_raw = row.get("listing_id") or ""

    artist_name = safe_text(artist_name_raw)
    artwork_title = safe_text(artwork_title_raw)
    seller_name = safe_text(seller_name_raw)

    price_raw = row.get("price")
    price_numeric = parse_price(price_raw)
    price_for_filter = price_numeric if price_numeric is not None else -1
    base_price_html = build_price_html(row)

    shipping = parse_bool(row.get("shipping_included"))
    coa = parse_bool(row.get("certificate_of_authenticity_included"))

    status_lower = status_raw.strip().lower()
    is_sold = status_lower == "sold"
    is_pending = status_lower == "pending"

    seller_profile_url = (row.get("seller_profile_url") or "").strip()
    seller_email_raw = (row.get("seller_email") or "").strip()
    listing_id = html.escape(str(listing_id_raw))

    full_image_src = drive_thumbnail_url(row.get("source_image_url"), "w1200")
    alt_text = safe_text(row.get("artwork_title") or row.get("artist_name") or "Artwork")

    # ---------- Card-only summary ----------

    image_html = ""
    if image_src:
        image_html = f"""
        <button class="image-open" type="button" data-fullsrc="{image_src}" data-alt="{alt_text}" aria-label="Open artwork image">
            <img
                src="{image_src}"
                data-fullsrc="{full_image_src}"
                class="art-img"
                alt="{alt_text}"
                loading="lazy"
                decoding="async"
            >
        </button>
        """

    save_heart_html = (
        f'<button class="save-listing-button corner-heart" type="button" '
        f'data-listing-id="{listing_id}" aria-label="Save listing">♡</button>'
    )

    # Price with status treatment for the card
    if is_sold:
        card_price_html = (
            f'<div class="price-with-status sold-treatment">{base_price_html}'
            f'<span class="sold-mark">Sold</span></div>'
        )
    elif is_pending:
        card_price_html = (
            f'<div class="price-with-status pending-treatment">{base_price_html}'
            f'<span class="pending-mark">Pending</span></div>'
        )
    else:
        card_price_html = base_price_html

    category_badge_html = ""
    if artwork_category_raw:
        category_class_modifier = ""
        if artwork_category_raw == "Unique/Original":
            category_class_modifier = " category-unique"
        elif artwork_category_raw == "Limited Edition":
            category_class_modifier = " category-limited"
        category_badge_html = (
            f'<span class="badge artwork-category-badge card-badge{category_class_modifier}">'
            f'{safe_text(artwork_category_raw)}</span>'
        )

    contact_button_html = ""
    if seller_profile_url and not is_sold:
        safe_url = html.escape(seller_profile_url, quote=True)
        contact_button_html = (
            f'<a href="{safe_url}" target="_blank" rel="noopener noreferrer" '
            f'class="contact-seller-button">Message on Facebook</a>'
        )

    show_more_button_html = (
        f'<button class="show-more-button" type="button" data-listing-id="{listing_id}" '
        f'aria-label="Show more details">Show More <span class="chevron">▾</span></button>'
    )

    # ---------- Modal-only content ----------

    # Skip the status pill when the listing is available — the catalog only shows
    # available/pending listings, so an "Available" pill would be redundant noise.
    modal_status_pill = ""
    if status_raw.strip() and status_lower != "available":
        status_class = "status-pill"
        if is_sold:
            status_class += " status-sold"
        elif is_pending:
            status_class += " status-pending"
        modal_status_pill = f'<span class="{status_class}">{safe_text(status_raw)}</span>'

    modal_badge_parts = []
    if shipping is True:
        modal_badge_parts.append('<span class="badge">Shipping Included</span>')
    elif shipping is False:
        modal_badge_parts.append('<span class="badge badge-warn">Shipping Extra</span>')
    if coa is True:
        modal_badge_parts.append('<span class="badge">COA Included</span>')
    elif coa is False:
        modal_badge_parts.append('<span class="badge badge-warn">No COA</span>')
    modal_badges_html = "".join(modal_badge_parts)

    modal_specs_html = build_specs(row)
    modal_notes_html = build_notes(row)

    # Email Seller button — only renders in the modal, not on the card.
    email_button_html = ""
    if seller_email_raw and not is_sold:
        safe_email = html.escape(seller_email_raw, quote=True)
        email_button_html = (
            f'<a href="mailto:{safe_email}" class="email-seller-button">'
            f'Email Seller</a>'
        )

    seller_location_raw = (row.get("seller_location") or "").strip()
    seller_location_html = ""
    if seller_location_raw:
        seller_location_html = (
            f'<div class="seller-location">'
            f'<span class="location-label">Location:</span> '
            f'<span class="location-value">{safe_text(seller_location_raw)}</span>'
            f'</div>'
        )

    # Seller mood pill — sits with the seller actions, color-coded so buyers can
    # read the seller's stance at a glance.
    seller_mood_raw = (row.get("seller_mood") or "").strip()
    seller_mood_html = ""
    if seller_mood_raw and not is_sold:
        mood_lookup = {
            "Open to Offers": "mood-open",
            "Price Firm": "mood-firm",
            "Motivated to Sell": "mood-motivated",
            "Testing the Market": "mood-testing",
        }
        mood_class = mood_lookup.get(seller_mood_raw, "mood-default")
        seller_mood_html = (
            f'<div class="seller-mood-row">'
            f'<span class="seller-mood-label">Seller note</span>'
            f'<span class="seller-mood-pill {mood_class}">{safe_text(seller_mood_raw)}</span>'
            f'</div>'
        )

    modal_seller_html = ""
    if seller_name_raw:
        modal_seller_actions = ""
        if contact_button_html or email_button_html:
            modal_seller_actions = f"""
                    <div class="modal-seller-actions">
                        {contact_button_html}
                        {email_button_html}
                    </div>
            """
        modal_seller_html = f"""
            <div class="modal-seller">
                <span class="seller-label">Seller</span>
                <span class="seller-name">{seller_name}</span>
                {seller_location_html}
                {modal_seller_actions}
                {seller_mood_html}
            </div>
        """
    elif seller_location_html:
        # Seller name missing but location present — still surface the location.
        modal_seller_html = f'<div class="modal-seller">{seller_location_html}</div>'

    searchable_text = " ".join(
        [
            str(artist_name_raw),
            str(artwork_title_raw),
            str(medium_raw),
            str(artwork_category_raw),
            str(seller_name_raw),
            str(status_raw),
            str(row.get("seller_notes") or ""),
        ]
    ).lower()

    newest_value = newest_sort_value(row)

    return f"""
    <article class="card"
        data-listing-id="{listing_id}"
        data-artist="{html.escape(str(artist_name_raw).lower())}"
        data-seller="{html.escape(str(seller_name_raw).lower())}"
        data-medium="{html.escape(str(medium_raw).lower())}"
        data-category="{html.escape(str(artwork_category_raw).lower())}"
        data-status="{html.escape(str(status_raw).lower())}"
        data-price="{price_for_filter}"
        data-price-band="{get_price_band(price_numeric)}"
        data-price-drop="{str(is_price_drop(row)).lower()}"
        data-shipping="{'' if shipping is None else str(shipping).lower()}"
        data-coa="{'' if coa is None else str(coa).lower()}"
        data-newest="{newest_value}"
        data-search="{html.escape(searchable_text)}">

        <div class="card-image-wrap">
            {image_html}
            {save_heart_html}
        </div>

        <div class="card-body">
            <h2 class="artist-name">{artist_name}</h2>
            <div class="artwork-title">{artwork_title}</div>

            <div class="card-price-row">
                {card_price_html}
                {category_badge_html}
            </div>

            <div class="card-actions">
                {contact_button_html}
                {show_more_button_html}
            </div>
        </div>

        <template class="modal-content-template">
            <div class="modal-content-inner">
                <div class="modal-image-wrap">
                    <button class="image-open modal-image-zoom" type="button" data-fullsrc="{full_image_src}" data-alt="{alt_text}" aria-label="Open artwork image">
                        <img src="{full_image_src}" class="modal-art-img" alt="{alt_text}">
                    </button>
                </div>
                <div class="modal-info">
                    <div class="modal-header">
                        <h2 class="artist-name">{artist_name}</h2>
                        <div class="artwork-title">{artwork_title}</div>
                        <div class="modal-price-row">
                            {base_price_html}
                            {category_badge_html}
                            {modal_status_pill}
                        </div>
                    </div>

                    <div class="modal-badges">{modal_badges_html}</div>

                    <div class="modal-specs">{modal_specs_html}</div>

                    {modal_seller_html}

                    {modal_notes_html}
                </div>
            </div>
        </template>
    </article>
    """


def summary_stats(data):
    available_rows = [r for r in data if (r.get("status") or "").strip().lower() != "sold"]

    listing_count = len(available_rows)

    artist_count = len({
        (r.get("artist_name") or "").strip().lower()
        for r in available_rows
        if (r.get("artist_name") or "").strip()
    })

    seller_count = len({
        (r.get("seller_name") or "").strip().lower()
        for r in available_rows
        if (r.get("seller_name") or "").strip()
    })

    return {
        "listing_count": listing_count,
        "artist_count": artist_count,
        "seller_count": seller_count,
    }


def unique_values(data, key):
    values = sorted({
        (row.get(key) or "").strip()
        for row in data
        if (row.get(key) or "").strip()
    })
    return values


def generate_guidelines_html(output_path: Path, title: str):
    index_src = "index.html"
    logo_src = "assets/logo.png"

    buying_items = "\n".join(f"<li>{safe_text(item)}</li>" for item in BUYING_GUIDELINES)
    shipping_items = "\n".join(f"<li>{safe_text(item)}</li>" for item in SHIPPING_GUIDELINES)

    meta_tags_html = build_meta_tags(
        page_title=f"{title} — Buying & Shipping Guidelines",
        description="Community guidelines for safer payments, smoother transactions, and better shipping when buying or selling on Canvas Circle.",
        url_path="guidelines.html",
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="icon" href="assets/favicon.ico">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{safe_text(title)} — Buying & Shipping Guidelines</title>
{meta_tags_html}
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
    <meta name="theme-color" content="#1f1a17">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="Canvas Circle">
    <style>
        :root {{
            --bg: #f5f1ea;
            --card: rgba(255,255,255,0.86);
            --text: #1f1a17;
            --muted: #6f675e;
            --line: #dbd1c4;
            --shadow-soft: 0 8px 22px rgba(35, 27, 20, 0.05);
        }}

        * {{
            box-sizing: border-box;
        }}

        body {{
            margin: 0;
            color: var(--text);
            background:
                radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 35%),
                linear-gradient(180deg, #f7f3ed 0%, #f2ece3 100%);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.6;
        }}

        .page {{
            max-width: 980px;
            margin: 0 auto;
            padding: 32px 20px 80px;
        }}

        .hero {{
            display: grid;
            grid-template-columns: 120px 1fr;
            gap: 24px;
            align-items: center;
            padding-bottom: 24px;
            border-bottom: 1px solid var(--line);
            margin-bottom: 28px;
        }}

        .brand-logo {{
            width: 108px;
            max-width: 100%;
            height: auto;
            display: block;
            filter: drop-shadow(0 8px 18px rgba(0,0,0,0.08));
        }}

        .hero-copy h1 {{
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            font-size: clamp(30px, 4vw, 48px);
            line-height: 1.02;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .hero-sub {{
            margin-top: 14px;
            color: var(--muted);
            max-width: 720px;
            font-size: 16px;
        }}

        .hero-links {{
            margin-top: 14px;
        }}

        .hero-link {{
            color: var(--text);
            text-decoration: none;
            font-size: 14px;
            border-bottom: 1px solid rgba(31, 26, 23, 0.25);
        }}

        .hero-link:hover {{
            border-bottom-color: rgba(31, 26, 23, 0.65);
        }}

        .notice {{
            background: var(--card);
            border: 1px solid rgba(219, 209, 196, 0.85);
            border-radius: 18px;
            padding: 18px 20px;
            box-shadow: var(--shadow-soft);
            margin-bottom: 26px;
            color: var(--text);
        }}

        .notice strong {{
            display: block;
            margin-bottom: 6px;
            font-size: 14px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
        }}

        .section {{
            background: var(--card);
            border: 1px solid rgba(219, 209, 196, 0.85);
            border-radius: 22px;
            padding: 24px 24px 26px;
            box-shadow: var(--shadow-soft);
            margin-bottom: 20px;
        }}

        .section h2 {{
            margin: 0 0 14px;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 30px;
            line-height: 1.05;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .section ul {{
            margin: 0;
            padding-left: 20px;
        }}

        .section li {{
            margin-bottom: 14px;
        }}

        .footer-link {{
            margin-top: 28px;
            text-align: center;
        }}

        .footer-link a {{
            color: var(--text);
            text-decoration: none;
            border-bottom: 1px solid rgba(31, 26, 23, 0.25);
        }}

        .footer-link a:hover {{
            border-bottom-color: rgba(31, 26, 23, 0.65);
        }}

        @media (max-width: 720px) {{
            .page {{
                padding: 24px 16px 70px;
            }}

            .hero {{
                grid-template-columns: 1fr;
                gap: 14px;
                align-items: start;
            }}

            .brand-logo {{
                width: 78px;
            }}

            .section {{
                padding: 20px 18px 22px;
            }}

            .section h2 {{
                font-size: 26px;
            }}
        }}
    </style>
</head>
<body>
    <div class="page">
        <header class="hero">
            <div>
                <img src="{logo_src}" class="brand-logo" alt="Unique Original Fine Art">
            </div>
            <div class="hero-copy">
                <h1>Buying & Shipping Guidelines</h1>
                <div class="hero-sub">
                    These are general community guidelines. All sales are handled directly between buyer and seller.
                </div>
                <div class="hero-links">
                    <a class="hero-link" href="{index_src}">Back to catalog</a>
                </div>
            </div>
        </header>

        <div class="notice">
            <strong>Please Note</strong>
            Use these guidelines for smoother transactions, safer payments, and better shipping outcomes.
        </div>

        <section class="section">
            <h2>Useful Tips for Buying</h2>
            <ul>
                {buying_items}
            </ul>
        </section>

        <section class="section">
            <h2>Useful Tips for Shipping Art</h2>
            <ul>
                {shipping_items}
            </ul>
        </section>

        <div class="footer-link">
            <a href="{index_src}">Return to the art catalog</a>
        </div>
    </div>
</body>
</html>"""


def generate_about_html(output_path: Path, title: str):
    index_src = "index.html"
    logo_src = "assets/logo.png"

    meta_tags_html = build_meta_tags(
        page_title="About Canvas Circle",
        description="Canvas Circle is a modern art marketplace built for social selling — bringing structure and a centralized catalog to community art resale.",
        url_path="about.html",
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="icon" href="assets/favicon.ico">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{safe_text(title)} — About</title>
{meta_tags_html}
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
    <meta name="theme-color" content="#1f1a17">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="Canvas Circle">
    <style>
        :root {{
            --bg: #f5f1ea;
            --card: rgba(255,255,255,0.86);
            --text: #1f1a17;
            --muted: #6f675e;
            --line: #dbd1c4;
            --shadow-soft: 0 8px 22px rgba(35, 27, 20, 0.05);
        }}

        * {{
            box-sizing: border-box;
        }}

        body {{
            margin: 0;
            color: var(--text);
            background:
                radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 35%),
                linear-gradient(180deg, #f7f3ed 0%, #f2ece3 100%);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.6;
        }}

        .page {{
            max-width: 980px;
            margin: 0 auto;
            padding: 32px 20px 80px;
        }}

        .hero {{
            display: grid;
            grid-template-columns: 120px 1fr;
            gap: 24px;
            align-items: center;
            padding-bottom: 24px;
            border-bottom: 1px solid var(--line);
            margin-bottom: 28px;
        }}

        .brand-logo {{
            width: 108px;
            max-width: 100%;
            height: auto;
            display: block;
            filter: drop-shadow(0 8px 18px rgba(0,0,0,0.08));
        }}

        .hero-copy h1 {{
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            font-size: clamp(30px, 4vw, 48px);
            line-height: 1.02;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .hero-sub {{
            margin-top: 14px;
            color: var(--muted);
            max-width: 720px;
            font-size: 16px;
        }}

        .hero-links {{
            margin-top: 14px;
        }}

        .hero-link {{
            color: var(--text);
            text-decoration: none;
            font-size: 14px;
            border-bottom: 1px solid rgba(31, 26, 23, 0.25);
        }}

        .hero-link:hover {{
            border-bottom-color: rgba(31, 26, 23, 0.65);
        }}

        .section {{
            background: var(--card);
            border: 1px solid rgba(219, 209, 196, 0.85);
            border-radius: 22px;
            padding: 24px 28px 26px;
            box-shadow: var(--shadow-soft);
            margin-bottom: 20px;
        }}

        .section h2 {{
            margin: 0 0 16px;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 30px;
            line-height: 1.05;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .section p {{
            margin: 0 0 14px;
            font-size: 16px;
            line-height: 1.65;
        }}

        .section p.lede {{
            font-size: 18px;
            color: var(--text);
        }}

        .section p:last-child {{
            margin-bottom: 0;
        }}

        .section ul {{
            margin: 14px 0 18px;
            padding-left: 22px;
        }}

        .section li {{
            margin-bottom: 8px;
            font-size: 16px;
            line-height: 1.55;
        }}

        .feature-list {{
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 18px;
            margin-top: 16px;
        }}

        .feature {{
            background: rgba(255,255,255,0.6);
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 16px 18px;
        }}

        .feature h3 {{
            margin: 0 0 6px;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 18px;
            font-weight: 600;
            letter-spacing: -0.01em;
        }}

        .feature p {{
            margin: 0;
            font-size: 14px;
            line-height: 1.5;
            color: var(--muted);
        }}

        .footer-link {{
            margin-top: 28px;
            text-align: center;
        }}

        .footer-link a {{
            color: var(--text);
            text-decoration: none;
            border-bottom: 1px solid rgba(31, 26, 23, 0.25);
        }}

        .footer-link a:hover {{
            border-bottom-color: rgba(31, 26, 23, 0.65);
        }}

        @media (max-width: 720px) {{
            .page {{
                padding: 24px 16px 70px;
            }}

            .hero {{
                grid-template-columns: 1fr;
                gap: 14px;
                align-items: start;
            }}

            .brand-logo {{
                width: 78px;
            }}

            .section {{
                padding: 20px 18px 22px;
            }}

            .section h2 {{
                font-size: 26px;
            }}

            .feature-list {{
                grid-template-columns: 1fr;
                gap: 12px;
            }}
        }}
    </style>
</head>
<body>
    <div class="page">
        <header class="hero">
            <div>
                <img src="{logo_src}" class="brand-logo" alt="Canvas Circle">
            </div>
            <div class="hero-copy">
                <h1>About Canvas Circle</h1>
                <div class="hero-sub">
                    A modern art marketplace built for social selling.
                </div>
                <div class="hero-links">
                    <a class="hero-link" href="{index_src}">Back to catalog</a>
                </div>
            </div>
        </header>

        <section class="section">
            <p class="lede">Canvas Circle is a modern art marketplace built for social selling.</p>
            <p>Today, a large portion of art resale happens across Facebook groups and online communities. While these spaces are active and valuable, they're often unstructured. Listings can be inconsistent, incomplete, and difficult to navigate. Important details get lost, and both buyers and sellers spend unnecessary time managing the process.</p>
            <p>There's also the constant pressure to stay visible by bumping posts, reposting listings, and competing with ever-changing algorithms just to be seen.</p>
            <p><strong>Canvas Circle brings structure to that environment.</strong></p>
            <p>It provides a simple, consistent way to create clean, organized listings that include all the information buyers actually need without unnecessary clutter. Instead of relying on individual posts, listings live in a centralized online catalog. Sellers can direct buyers to their listings through a clean, filterable interface — making it easier for buyers to browse, compare, and engage without the noise of social feeds.</p>
            <p>Canvas Circle acts as a marketplace, but transactions stay direct. We don't process payments, handle logistics, or sit in the middle of transactions. Instead, we provide the infrastructure that helps buyers and sellers connect more efficiently, while maintaining the flexibility and independence of social selling.</p>
        </section>

        <section class="section">
            <h2>Why Canvas Circle Exists</h2>
            <p><em>Better listings lead to better outcomes.</em></p>
            <p>When listings are clear, complete, and consistent:</p>
            <ul>
                <li>Buyers can quickly find relevant works</li>
                <li>Sellers receive more serious inquiries</li>
                <li>Less time is spent reformatting, reposting, and competing for visibility</li>
            </ul>
            <p>Canvas Circle reduces the friction of social selling by replacing scattered posts with a structured, centralized experience.</p>
        </section>

        <section class="section">
            <h2>What Makes Canvas Circle Different</h2>
            <p>Canvas Circle is designed around how art is actually bought and sold today.</p>
            <div class="feature-list">
                <div class="feature">
                    <h3>Structured Listings</h3>
                    <p>Every listing follows a clean, consistent format that highlights what matters most.</p>
                </div>
                <div class="feature">
                    <h3>Centralized Catalog</h3>
                    <p>All listings live in one place, making it easy for buyers to browse and filter.</p>
                </div>
                <div class="feature">
                    <h3>Built for Social Use</h3>
                    <p>Sellers can easily direct buyers to their listings without relying on constant reposting.</p>
                </div>
                <div class="feature">
                    <h3>Direct Transactions</h3>
                    <p>Buyers and sellers connect directly, with no fees or intermediaries.</p>
                </div>
            </div>
        </section>

        <section class="section">
            <h2>A Better Way to Sell Art Online</h2>
            <p>Canvas Circle doesn't replace social platforms — it complements them.</p>
            <p>By combining structured listings with a centralized catalog, it transforms fragmented, feed-based selling into a more organized, efficient, and professional marketplace experience.</p>
        </section>

        <div class="footer-link">
            <a href="{index_src}">Return to the art catalog</a>
        </div>
    </div>
</body>
</html>"""


def generate_html(data, images_path: Path, output_path: Path, title, month_label):
    stats = summary_stats(data)

    def card_html(row):
        image_src = build_image_src(row, output_path, images_path)
        return build_card(row, image_src)

    catalog_cards = "\n".join(card_html(row) for row in data)

    artists = unique_values(data, "artist_name")
    sellers = unique_values(data, "seller_name")
    artist_options = '<option value="">All Artists</option>' + "".join(
        f'<option value="{safe_text(a.lower())}">{safe_text(a)}</option>' for a in artists
    )
    seller_options = '<option value="">All Sellers</option>' + "".join(
        f'<option value="{safe_text(s.lower())}">{safe_text(s)}</option>' for s in sellers
    )
    logo_src = "https://raw.githubusercontent.com/unique-original-fineart/art_catalog/main/assets/logo.png"
    guidelines_src = "guidelines.html"
    about_src = "about.html"
    form_src = "https://docs.google.com/forms/d/e/1FAIpQLSfr5B0TPSlUfU-oeGcpi8Q8oLS-ePqVU4q_8mFrOPCHy5jc3Q/viewform?usp=header"

    meta_tags_html = build_meta_tags(
        page_title=title,
        description="Canvas Circle is a modern art marketplace built for social selling. Browse curated original and limited-edition artwork from the community.",
        url_path="",
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="icon" href="assets/favicon.ico">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{safe_text(title)}</title>
{meta_tags_html}
    <!-- Progressive Web App: install to home screen on iOS / Android. -->
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
    <meta name="theme-color" content="#1f1a17">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="Canvas Circle">
    <style>
        :root {{
            --bg: #f5f1ea;
            --card: rgba(255,255,255,0.82);
            --text: #1f1a17;
            --muted: #6f675e;
            --line: #dbd1c4;
            --shadow: 0 18px 40px rgba(35, 27, 20, 0.08);
            --shadow-soft: 0 8px 22px rgba(35, 27, 20, 0.05);
        }}

        * {{
            box-sizing: border-box;
        }}

        html {{
            scroll-behavior: smooth;
        }}

        body {{
            margin: 0;
            color: var(--text);
            background:
                radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 35%),
                linear-gradient(180deg, #f7f3ed 0%, #f2ece3 100%);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.45;
        }}

        .page {{
            max-width: 1360px;
            margin: 0 auto;
            padding: 32px 28px 90px;
        }}

        .hero {{
            padding: 4px 0 20px;
            margin-bottom: 20px;
            border-bottom: 1px solid var(--line);
        }}
        .banner-wrap {{
            width: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 0 0 20px;
        }}

        .banner-logo {{
            max-width: 600px;
            width: 100%;
            height: auto;
            display: block;
        }}

        .centered-link {{
            text-align: center;
            margin-top: 10px;
        }}


        .hero-top {{
            display: grid;
            grid-template-columns: 160px 1fr;
            gap: 28px;
            align-items: center;
        }}

        .brand {{
            display: flex;
            align-items: center;
            justify-content: flex-start;
        }}

        .brand-logo {{
            width: 150px;
            max-width: 100%;
            height: auto;
            display: block;
            filter: drop-shadow(0 8px 18px rgba(0,0,0,0.08));
        }}

        .hero-copy {{
            display: flex;
            flex-direction: column;
            justify-content: center;
            min-width: 0;
            max-width: 760px;
        }}

        h1 {{
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            font-size: clamp(28px, 4vw, 48px);
            line-height: 0.96;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .hero-sub {{
            max-width: 640px;
            margin-top: 14px;
            color: var(--muted);
            font-size: 16px;
            line-height: 1.5;
        }}

        .hero-links {{
            margin-top: 14px;
        }}

        .hero-link {{
            color: var(--text);
            text-decoration: none;
            font-size: 14px;
            border-bottom: 1px solid rgba(31, 26, 23, 0.25);
        }}

        .hero-link:hover {{
            border-bottom-color: rgba(31, 26, 23, 0.65);
        }}

        .hero-link-divider {{
            color: var(--muted);
            font-size: 14px;
            margin: 0 4px;
        }}

        .hero-link-short {{
            display: none;
        }}

        .stats-bar {{
            display: flex;
            align-items: center;
            gap: 0;
            margin-top: 24px;
            padding: 16px 22px;
            background: var(--card);
            border: 1px solid rgba(219, 209, 196, 0.85);
            border-radius: 18px;
            box-shadow: var(--shadow-soft);
            width: fit-content;
            max-width: 100%;
        }}

        .stat-chip {{
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 0 18px;
        }}

        .stat-chip:first-child {{
            padding-left: 0;
        }}

        .stat-chip:last-child {{
            padding-right: 0;
        }}

        .stat-chip-label {{
            font-size: 11px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--muted);
            white-space: nowrap;
        }}

        .stat-chip-value {{
            font-family: Georgia, "Times New Roman", serif;
            font-size: 28px;
            line-height: 1;
        }}

        .stat-divider {{
            width: 1px;
            align-self: stretch;
            background: var(--line);
            opacity: 0.9;
        }}

        .section {{
            margin-top: 42px;
        }}

        .section-heading {{
            display: flex;
            justify-content: space-between;
            align-items: end;
            gap: 20px;
            margin-bottom: 18px;
        }}

        .section h3 {{
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 30px;
            line-height: 1.05;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .section-note {{
            color: var(--muted);
            font-size: 14px;
        }}

        .filters {{
            display: grid;
            grid-template-columns: 2fr repeat(6, 1fr);
            gap: 12px;
            margin: 0 0 20px;
        }}

        .filters input,
        .filters select,
        .download-saved-button {{
            width: 100%;
            padding: 14px 15px;
            border-radius: 14px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.92);
            color: var(--text);
            font-size: 14px;
            box-shadow: var(--shadow-soft);
        }}

        /* Price range filter — two number inputs sharing a single rounded field. */
        .filters .price-range {{
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 10px;
            border-radius: 14px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.92);
            box-shadow: var(--shadow-soft);
            min-width: 0;
        }}
        .filters .price-range-input {{
            border: none;
            background: transparent;
            box-shadow: none;
            padding: 14px 4px;
            font-size: 14px;
            width: 100%;
            min-width: 0;
            color: var(--text);
            appearance: textfield;
            -moz-appearance: textfield;
        }}
        .filters .price-range-input:focus {{
            outline: none;
        }}
        .filters .price-range-input::-webkit-outer-spin-button,
        .filters .price-range-input::-webkit-inner-spin-button {{
            -webkit-appearance: none;
            margin: 0;
        }}
        .filters .price-range-prefix {{
            color: var(--muted);
            font-size: 14px;
            font-weight: 600;
        }}
        .filters .price-range-sep {{
            color: var(--muted);
            font-size: 14px;
            padding: 0 2px;
        }}

        
        .download-saved-button {{
            cursor: pointer;
            font-weight: 600;
        }}

        .download-saved-button:disabled {{
            opacity: 0.55;
            cursor: not-allowed;
        }}

        .result-row {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 18px;
            margin-bottom: 18px;
            flex-wrap: wrap;
        }}

        .clear-filters-button {{
            appearance: none;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.92);
            color: var(--text);
            padding: 8px 16px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease;
            white-space: nowrap;
        }}

        .clear-filters-button:hover {{
            background: white;
            border-color: rgba(31,26,23,0.4);
        }}

        .result-meta {{
            display: flex;
            flex-wrap: wrap;
            gap: 14px;
            align-items: center;
        }}

        .result-count,
        .saved-count {{
            color: var(--muted);
            font-size: 14px;
        }}

        .grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 28px;
        }}

        .card {{
            background: var(--card);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(219, 209, 196, 0.85);
            border-radius: 26px;
            overflow: hidden;
            box-shadow: var(--shadow);
            display: flex;
            flex-direction: column;
            transition: transform 0.18s ease, box-shadow 0.18s ease;
        }}

        .card:hover {{
            transform: translateY(-3px);
            box-shadow: 0 24px 48px rgba(35, 27, 20, 0.12);
        }}

        .card:hover .art-img {{
            transform: scale(1.03);
        }}

        .card.hidden {{
            display: none;
        }}

        .card-image-wrap {{
            display: flex;
            align-items: center;
            justify-content: center;
            background:
                linear-gradient(180deg, rgba(255,255,255,0.6), rgba(239,232,220,0.9));
            border-bottom: 1px solid var(--line);
            padding: 22px;
            aspect-ratio: 1 / 1;
            overflow: hidden;
        }}

        .image-open {{
            appearance: none;
            border: none;
            background: transparent;
            padding: 0;
            margin: 0;
            cursor: zoom-in;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
        }}

        .art-img {{
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
            object-fit: contain;
            display: block;
            background: #f3efe8;
            border: 6px solid white;
            border-radius: 8px;
            box-shadow:
                0 2px 6px rgba(0,0,0,0.08),
                0 12px 30px rgba(0,0,0,0.12);
            transition: transform 0.4s ease;
        }}

        .card-body {{
            padding: 22px 22px 24px;
        }}

        .card-header {{
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: start;
        }}

        .artist-name {{
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 20px;
            line-height: 1.05;
            letter-spacing: -0.03em;
            font-weight: 600;
        }}

        .artwork-title {{
            margin-top: 10px;
            font-size: 16px;
            font-style: italic;
            color: var(--muted);
        }}

        .price {{
            white-space: nowrap;
            font-size: 22px;
            font-weight: 700;
            letter-spacing: -0.02em;
        }}

        .price-drop-price {{
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 4px;
            line-height: 1.05;
        }}

        .price-drop-label {{
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 5px 9px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            border: 1px solid var(--line);
            background: #fff4df;
            color: #7a4d00;
        }}

        .price-stack {{
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 2px;
        }}

        .old-price {{
            color: var(--muted);
            font-size: 15px;
            font-weight: 600;
            text-decoration: line-through;
            text-decoration-thickness: 1.5px;
        }}

        .new-price {{
            color: var(--text);
            font-size: 24px;
            font-weight: 800;
            letter-spacing: -0.03em;
        }}

        .badges {{
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 16px;
        }}

        .badge,
        .status-pill {{
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 7px 11px;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.01em;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.92);
        }}

        .badge-muted {{
            color: var(--muted);
        }}

        .badge-warn {{
            background: #fbf3df;
            color: #715814;
            border-color: #ecdca8;
        }}

        .artwork-category-badge {{
            background: #eef4ff;
            color: #274060;
            border-color: #cbd9ef;
        }}

        .artwork-category-badge.category-unique {{
            background: #e6f5e8;
            color: #1e5e2a;
            border-color: #b8dfbf;
        }}

        .price-drop-badge {{
            background: #fff4df;
            color: #7a4d00;
            border-color: #efd29d;
        }}

        .status-available {{
            background: #edf6ee;
        }}

        .status-pending {{
            background: #fbf3df;
        }}

        .status-sold {{
            background: #f6e5e5;
        }}

        .specs {{
            margin-top: 18px;
            padding-top: 14px;
            border-top: 1px solid var(--line);
        }}

        .spec-row {{
            display: flex;
            justify-content: space-between;
            gap: 18px;
            padding: 7px 0;
        }}

        .spec-label {{
            color: var(--muted);
            font-size: 13px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }}

        .spec-value {{
            text-align: right;
            font-size: 14px;
            font-weight: 500;
        }}

        .seller {{
            margin-top: 18px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }}

        .seller-label {{
            color: var(--muted);
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }}

        .seller-name {{
            font-size: 18px;
            font-weight: 700;
            line-height: 1.2;
            color: var(--text);
        }}

        .seller-name a {{
            color: var(--text);
            text-decoration: none;
            border-bottom: 1px solid rgba(31, 26, 23, 0.25);
        }}

        .seller-name a:hover {{
            border-bottom-color: rgba(31, 26, 23, 0.65);
        }}

        .seller-contact-note {{
            color: var(--muted);
            font-size: 13px;
            margin-top: 2px;
        }}

        .listing-actions {{
            margin-top: 16px;
        }}

        .save-listing-button,
        .download-listing-button {{
            appearance: none;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.92);
            color: var(--text);
            padding: 10px 14px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
        }}
        .contact-seller-button {{
            display: inline-flex;
            align-items: center;
            width: fit-content;
            margin-top: 8px;
            padding: 10px 14px;
            border-radius: 999px;
            background: #1f1a17;
            color: #ffffff;
            text-decoration: none;
            font-size: 13px;
            font-weight: 600;
            border: 1px solid #1f1a17;
            transition: transform 0.2s ease, opacity 0.2s ease;
        }}

        .contact-seller-button:hover {{
            transform: translateY(-1px);
            opacity: 0.9;
        }}
        .save-listing-button:hover,
        .download-listing-button:hover {{
            transform: translateY(-1px);
        }}

        .save-listing-button.is-saved {{
            background: #1f1a17;
            color: #ffffff;
            border-color: #1f1a17;
        }}

        .notes {{
            margin-top: 12px;
            font-size: 14px;
            color: var(--text);
        }}

        #backToTop {{
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 46px;
            height: 46px;
            border-radius: 50%;
            border: none;
            background: #1f1a17;
            color: #ffffff;
            font-size: 20px;
            cursor: pointer;
            box-shadow: 0 8px 20px rgba(0,0,0,0.20);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }}

        #backToTop:hover {{
            opacity: 0.88;
        }}

        .lightbox {{
            position: fixed;
            inset: 0;
            background: rgba(20, 16, 12, 0.92);
            display: none;
            align-items: center;
            justify-content: center;
            padding: 20px;
            z-index: 3000;
        }}

        .lightbox.is-open {{
            display: flex;
        }}

        .lightbox-stage {{
            position: relative;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto;
            -webkit-overflow-scrolling: touch;
        }}

        .lightbox-image {{
            max-width: min(92vw, 1400px);
            max-height: 92vh;
            width: auto;
            height: auto;
            object-fit: contain;
            border-radius: 10px;
            background: #ffffff;
            box-shadow: 0 20px 60px rgba(0,0,0,0.35);
            touch-action: pinch-zoom;
        }}

        .lightbox-close {{
            position: absolute;
            top: 18px;
            right: 18px;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            border: none;
            background: rgba(255,255,255,0.14);
            color: #ffffff;
            font-size: 28px;
            line-height: 1;
            cursor: pointer;
            z-index: 2100;
        }}

        .lightbox-close:hover {{
            background: rgba(255,255,255,0.22);
        }}

        .lightbox-hint {{
            position: absolute;
            left: 50%;
            bottom: 18px;
            transform: translateX(-50%);
            color: rgba(255,255,255,0.78);
            font-size: 13px;
            letter-spacing: 0.02em;
            text-align: center;
            z-index: 2100;
        }}

        
        .loading-overlay {{
            position: fixed;
            inset: 0;
            background: rgba(20, 16, 12, 0.50);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 3000;
            padding: 20px;
        }}

        .loading-overlay.is-open {{
            display: flex;
        }}

        .loading-box {{
            background: rgba(255,255,255,0.96);
            border: 1px solid rgba(219, 209, 196, 0.85);
            border-radius: 20px;
            box-shadow: 0 18px 40px rgba(35, 27, 20, 0.15);
            padding: 22px 24px;
            min-width: 260px;
            text-align: center;
        }}

        .loading-title {{
            font-family: Georgia, "Times New Roman", serif;
            font-size: 24px;
            margin: 0 0 8px;
        }}

        .loading-text {{
            color: var(--muted);
            font-size: 14px;
            margin: 0;
        }}

        /* === Card layout (new compact summary) === */
        .card-image-wrap {{
            position: relative;
        }}

        .save-listing-button.corner-heart {{
            position: absolute;
            top: 10px;
            right: 10px;
            width: 38px;
            height: 38px;
            padding: 0;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.94);
            border: 1px solid rgba(219, 209, 196, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            line-height: 1;
            color: #1f1a17;
            cursor: pointer;
            transition: transform 0.15s ease, background 0.15s ease, color 0.15s ease;
            z-index: 5;
            box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        }}

        .save-listing-button.corner-heart:hover {{
            transform: scale(1.06);
            background: white;
        }}

        .save-listing-button.corner-heart.is-saved {{
            background: #1f1a17;
            border-color: #1f1a17;
            color: white;
        }}

        .card-body .artist-name {{
            margin: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }}

        .card-body .artwork-title {{
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }}

        .card-price-row {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            margin-top: 10px;
            flex-wrap: nowrap;
        }}

        .card-price-row .price {{
            margin: 0;
            white-space: nowrap;
            flex-shrink: 0;
        }}

        .card-badge {{
            font-size: 10px;
            padding: 3px 7px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex-shrink: 1;
        }}

        .price-with-status {{
            display: inline-flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }}

        .sold-treatment .price {{
            color: var(--muted);
            text-decoration: line-through;
            text-decoration-thickness: 2px;
        }}

        .sold-mark {{
            display: inline-flex;
            align-items: center;
            background: #c93f3f;
            color: white;
            padding: 3px 9px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }}

        .pending-mark {{
            display: inline-flex;
            align-items: center;
            background: #fbf3df;
            color: #7a4d00;
            padding: 3px 9px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
        }}

        .card-actions {{
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 14px;
        }}

        .card-actions .contact-seller-button {{
            width: 100%;
            justify-content: center;
            margin-top: 0;
        }}

        .show-more-button {{
            appearance: none;
            border: 1px solid var(--line);
            background: transparent;
            color: var(--text);
            padding: 9px 12px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease;
        }}

        .show-more-button:hover {{
            background: rgba(255,255,255,0.6);
            border-color: rgba(31,26,23,0.4);
        }}

        .show-more-button .chevron {{
            display: inline-block;
            margin-left: 4px;
            transform: translateY(1px);
        }}

        /* === Empty state (no filter matches) === */
        .empty-state {{
            grid-column: 1 / -1;
            text-align: center;
            padding: 56px 24px;
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 22px;
            box-shadow: var(--shadow-soft);
        }}

        .empty-state[hidden] {{
            display: none;
        }}

        .empty-state-title {{
            margin: 0 0 8px;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 22px;
            font-weight: 600;
            color: var(--text);
            letter-spacing: -0.02em;
        }}

        .empty-state-message {{
            margin: 0 0 20px;
            color: var(--muted);
            font-size: 15px;
        }}

        .empty-state-clear {{
            appearance: none;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.96);
            color: var(--text);
            padding: 10px 20px;
            border-radius: 999px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease;
        }}

        .empty-state-clear:hover {{
            background: white;
            border-color: rgba(31,26,23,0.4);
        }}

        /* === Detail modal === */
        .detail-modal {{
            position: fixed;
            inset: 0;
            background: rgba(20, 16, 12, 0.78);
            display: none;
            align-items: stretch;
            justify-content: center;
            z-index: 2500;
            padding: 0;
        }}

        .detail-modal.is-open {{
            display: flex;
        }}

        .detail-modal-stage {{
            position: relative;
            background: #ffffff;
            width: 100%;
            max-width: 720px;
            max-height: 100vh;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
        }}

        .detail-modal-close {{
            position: absolute;
            top: 14px;
            right: 14px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            border: none;
            background: rgba(255,255,255,0.94);
            color: #1f1a17;
            font-size: 24px;
            line-height: 1;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.18);
            z-index: 10;
        }}

        .detail-modal-close:hover {{
            background: white;
        }}

        .modal-content-inner {{
            display: flex;
            flex-direction: column;
        }}

        .modal-image-wrap {{
            background: linear-gradient(180deg, rgba(255,255,255,0.6), rgba(239,232,220,0.9));
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 28px 24px;
            min-height: 320px;
            border-bottom: 1px solid var(--line);
        }}

        .modal-art-img {{
            max-width: 100%;
            max-height: 460px;
            width: auto;
            height: auto;
            object-fit: contain;
            background: #f3efe8;
            border: 6px solid white;
            border-radius: 8px;
            box-shadow: 0 12px 30px rgba(0,0,0,0.12);
        }}

        .image-open.modal-image-zoom {{
            width: auto;
            height: auto;
            max-width: 100%;
        }}

        .modal-info {{
            padding: 22px 24px 28px;
        }}

        .modal-header {{
            margin-bottom: 16px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--line);
        }}

        .modal-info .artist-name {{
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 22px;
            line-height: 1.1;
            letter-spacing: -0.025em;
            font-weight: 600;
        }}

        .modal-info .artwork-title {{
            margin-top: 6px;
            font-size: 16px;
            font-style: italic;
            color: var(--muted);
        }}

        .modal-price-row {{
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 12px;
            flex-wrap: nowrap;
        }}

        .modal-price-row .price {{
            white-space: nowrap;
            flex-shrink: 0;
        }}

        .modal-price-row .badge,
        .modal-price-row .status-pill {{
            white-space: nowrap;
        }}

        .modal-badges {{
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 16px;
        }}

        .modal-badges:empty {{
            display: none;
        }}

        .modal-specs {{
            margin-bottom: 16px;
            border-top: 1px solid var(--line);
            padding-top: 12px;
        }}

        .modal-specs:empty {{
            display: none;
            border-top: none;
            padding-top: 0;
        }}

        .modal-seller {{
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 16px 0;
            border-top: 1px solid var(--line);
        }}

        .modal-seller .seller-label {{
            color: var(--muted);
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }}

        .modal-seller .seller-name {{
            font-size: 18px;
            font-weight: 700;
            line-height: 1.2;
            color: var(--text);
        }}

        .modal-seller .seller-location {{
            font-size: 14px;
            color: var(--text);
        }}

        .modal-seller .seller-location .location-label {{
            color: var(--muted);
            font-weight: 600;
            margin-right: 4px;
        }}

        .modal-seller-actions {{
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 4px;
        }}

        .modal-seller-actions .contact-seller-button {{
            margin-top: 0;
        }}

        .seller-mood-row {{
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 12px;
            flex-wrap: wrap;
        }}

        .seller-mood-label {{
            color: var(--muted);
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            font-weight: 600;
        }}

        .seller-mood-pill {{
            display: inline-flex;
            align-items: center;
            padding: 5px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.92);
        }}

        .seller-mood-pill.mood-open {{
            background: #e6f5e8;
            color: #1e5e2a;
            border-color: #b8dfbf;
        }}

        .seller-mood-pill.mood-firm {{
            background: #efeae0;
            color: #4d3e23;
            border-color: #d8cdb6;
        }}

        .seller-mood-pill.mood-motivated {{
            background: #fbf3df;
            color: #7a4d00;
            border-color: #efd29d;
        }}

        .seller-mood-pill.mood-testing {{
            background: #eef4ff;
            color: #274060;
            border-color: #cbd9ef;
        }}

        .email-seller-button {{
            display: inline-flex;
            align-items: center;
            padding: 10px 14px;
            border-radius: 999px;
            border: 1px solid var(--line);
            background: rgba(255, 255, 255, 0.92);
            color: var(--text);
            text-decoration: none;
            font-size: 13px;
            font-weight: 600;
            transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
        }}

        .email-seller-button:hover {{
            transform: translateY(-1px);
            background: white;
            border-color: rgba(31, 26, 23, 0.4);
        }}


        @media (max-width: 1200px) {{
            .filters {{
                grid-template-columns: 1fr 1fr 1fr;
            }}
        }}

        @media (max-width: 980px) {{
            .hero-top {{
                grid-template-columns: 90px 1fr;
                gap: 18px;
            }}

            .brand-logo {{
                width: 82px;
            }}

            .stats-bar {{
                width: 100%;
                min-width: 0;
            }}
        }}
        @media (max-width: 720px) {{
            .banner-logo {{
                max-width: 90%;
            }}
        }}
        @media (max-width: 720px) {{
            .page {{
                padding: 24px 16px 70px;
            }}

            .hero {{
                padding: 0 0 12px;
                margin-bottom: 24px;
            }}

            .hero-link-full {{
                display: none;
            }}

            .hero-link-short {{
                display: inline;
            }}

            .hero-top {{
                grid-template-columns: 1fr;
                gap: 14px;
                align-items: start;
            }}

            .brand {{
                justify-content: flex-start;
            }}

            .brand-logo {{
                width: 74px;
                max-width: 50%;
            }}

            .hero-copy {{
                max-width: 100%;
            }}

            .hero-sub {{
                margin-top: 10px;
                font-size: 15px;
            }}

            .stats-bar {{
                padding: 12px 14px;
                margin-top: 18px;
            }}

            .stat-chip {{
                padding: 0 10px;
                gap: 4px;
            }}

            .stat-chip-label {{
                font-size: 10px;
                letter-spacing: 0.1em;
            }}

            .stat-chip-value {{
                font-size: 22px;
            }}

            .stat-divider {{
                width: 1px;
                height: auto;
                align-self: stretch;
            }}

            .filters {{
                grid-template-columns: 1fr;
                position: static;
                background: transparent;
                backdrop-filter: none;
                padding: 0;
                margin-bottom: 16px;
                gap: 10px;
            }}

            .filters input,
            .filters select,
            .download-saved-button {{
                padding: 12px 14px;
                font-size: 16px;
            }}

            .filters .price-range {{
                padding: 0 12px;
            }}
            .filters .price-range-input {{
                font-size: 16px; /* keep iOS Safari from auto-zooming on focus */
                padding: 12px 4px;
            }}

            .card-header {{
                flex-direction: column;
            }}

            .price {{
                white-space: normal;
            }}

            .price-drop-price,
            .price-stack {{
                align-items: flex-start;
            }}

            .seller-name {{
                font-size: 17px;
            }}

            #backToTop {{
                bottom: 16px;
                right: 16px;
                width: 48px;
                height: 48px;
            }}

            .lightbox {{
                padding: 12px;
            }}

            .lightbox-close {{
                top: 12px;
                right: 12px;
            }}

            .lightbox-hint {{
                bottom: 12px;
                font-size: 12px;
            }}

            /* === Mobile 2-up grid with rightsized cards ===
               To switch to 3-up (compact), change `repeat(2, ...)` below to `repeat(3, ...)`.
               To revert to 1-up, change to `1fr`.
               Card-only rules use `.card .X` so modal contents render at modal-appropriate sizes. */
            .grid {{
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 14px;
            }}

            .card {{
                border-radius: 16px;
            }}

            .card .card-image-wrap {{
                padding: 10px;
            }}

            .card .art-img {{
                border-width: 3px;
                border-radius: 6px;
            }}

            .card .card-body {{
                padding: 12px;
            }}

            .card .artist-name {{
                font-size: 14px;
                line-height: 1.1;
                letter-spacing: -0.025em;
            }}

            .card .artwork-title {{
                font-size: 11px;
                margin-top: 3px;
            }}

            .card .card-price-row {{
                margin-top: 8px;
                gap: 6px;
            }}

            .card .price {{
                font-size: 13px;
                margin: 0;
            }}

            /* On the 2-up mobile grid, the "Price Drop" pill takes too much
               horizontal room and squeezes the category badge — the strikethrough
               on the old price already conveys the price-drop concept. */
            .card .price-drop-label {{
                display: none;
            }}

            .card .old-price {{
                font-size: 10px;
            }}

            .card .new-price {{
                font-size: 13px;
            }}

            .card .card-badge {{
                font-size: 9px;
                padding: 2px 6px;
            }}

            .card .sold-mark,
            .card .pending-mark {{
                font-size: 10px;
                padding: 2px 7px;
            }}

            .card .save-listing-button.corner-heart {{
                width: 32px;
                height: 32px;
                font-size: 16px;
                top: 8px;
                right: 8px;
            }}

            .card .card-actions {{
                margin-top: 10px;
                gap: 6px;
            }}

            .card .contact-seller-button {{
                font-size: 11px;
                padding: 8px 10px;
            }}

            .card .show-more-button {{
                font-size: 11px;
                padding: 7px 10px;
            }}

            /* === Detail modal sizing on mobile === */
            .detail-modal-stage {{
                max-width: none;
                border-radius: 0;
            }}

            .modal-image-wrap {{
                min-height: 240px;
                padding: 18px;
            }}

            .modal-art-img {{
                max-height: 320px;
            }}

            .modal-info {{
                padding: 18px 18px 24px;
            }}

            .modal-info .artist-name {{
                font-size: 18px;
            }}

            .modal-info .artwork-title {{
                font-size: 14px;
            }}
        }}
    </style>
</head>
<body>
    <div class="page">
        <header class="hero">
            <div class="banner-wrap">
                <img src="{logo_src}" class="banner-logo" alt="Canvas Circle">
            </div>

            <div class="hero-links centered-link">
                <a class="hero-link" href="{about_src}">About</a>
                <span class="hero-link-divider"> · </span>
                <a class="hero-link" href="{guidelines_src}"><span class="hero-link-full">Buying/Shipping Guidelines</span><span class="hero-link-short">Guidelines</span></a>
                <span class="hero-link-divider"> · </span>
                <a class="hero-link" href="{form_src}" target="_blank" rel="noopener noreferrer">Submit a Listing</a>
            </div>

            <div class="stats-bar">
                <div class="stat-chip">
                    <span class="stat-chip-label">Available Listings</span>
                    <span class="stat-chip-value">{stats["listing_count"]}</span>
                </div>

                <div class="stat-divider"></div>

                <div class="stat-chip">
                    <span class="stat-chip-label">Artists</span>
                    <span class="stat-chip-value">{stats["artist_count"]}</span>
                </div>

                <div class="stat-divider"></div>

                <div class="stat-chip">
                    <span class="stat-chip-label">Sellers</span>
                    <span class="stat-chip-value">{stats["seller_count"]}</span>
                </div>
            </div>
        </header>

        <section class="section" id="full-catalog">
            <div class="section-heading">
                <h3>Full Catalog</h3>
                <div class="section-note">Browse by seller, artist, category, price, recency, or saved listings</div>
            </div>

            <div class="filters">
                <input type="text" id="searchInput" placeholder="Search artist, title, seller...">
                <select id="savedFilter">
                    <option value="">All Listings</option>
                    <option value="saved">Saved Only</option>
                    <option value="priceDrops">Price Drops</option>
                </select>
                <select id="sellerFilter">{seller_options}</select>
                <select id="artistFilter">{artist_options}</select>
                <select id="categoryFilter">
                    <option value="">Artwork Category</option>
                    <option value="unique/original">Unique/Original</option>
                    <option value="limited edition">Limited Edition</option>
                </select>
                <div class="price-range" role="group" aria-label="Price range filter">
                    <span class="price-range-prefix" aria-hidden="true">$</span>
                    <input id="priceMinInput" class="price-range-input" type="number" inputmode="numeric"
                        min="0" step="1" placeholder="Min" aria-label="Minimum price">
                    <span class="price-range-sep" aria-hidden="true">–</span>
                    <span class="price-range-prefix" aria-hidden="true">$</span>
                    <input id="priceMaxInput" class="price-range-input" type="number" inputmode="numeric"
                        min="0" step="1" placeholder="Max" aria-label="Maximum price">
                </div>
                <select id="sortFilter">
                    <option value="newest">Sort: Newest</option>
                    <option value="oldest">Sort: Oldest</option>
                    <option value="priceDesc">Price: High to Low</option>
                    <option value="priceAsc">Price: Low to High</option>
                    <option value="artistAsc">Artist: A to Z</option>
                    <option value="artistDesc">Artist: Z to A</option>
                </select>
            </div>

            <div class="result-row">
                <div class="result-meta">
                    <div class="result-count" id="resultCount"></div>
                    <div class="saved-count" id="savedCount"></div>
                </div>
                <button class="clear-filters-button" id="clearAllFiltersButton" type="button">
                    Clear all filters
                </button>
            </div>

            <div class="grid" id="catalogGrid">
                {catalog_cards}
                <div class="empty-state" id="emptyState" hidden>
                    <h3 class="empty-state-title">No listings match your filters</h3>
                    <p class="empty-state-message">Try clearing or adjusting your filters above.</p>
                    <button class="empty-state-clear" id="clearFiltersFromEmpty" type="button">Clear all filters</button>
                </div>
            </div>
        </section>
    </div>

    <button id="backToTop" aria-label="Back to top">↑</button>

    <div class="loading-overlay" id="loadingOverlay" aria-hidden="true">
        <div class="loading-box">
            <h4 class="loading-title" id="loadingTitle">Preparing PDF...</h4>
            <p class="loading-text" id="loadingText">Please wait while your download is generated.</p>
        </div>
    </div>

    <div class="lightbox" id="lightbox" aria-hidden="true">
        <button class="lightbox-close" id="lightboxClose" aria-label="Close image viewer">×</button>
        <div class="lightbox-stage" id="lightboxStage">
            <img class="lightbox-image" id="lightboxImage" src="" alt="">
        </div>
        <div class="lightbox-hint">Tap outside or × to close. Pinch to zoom on mobile.</div>
    </div>

    <div class="detail-modal" id="detailModal" aria-hidden="true" role="dialog" aria-label="Listing details">
        <div class="detail-modal-stage">
            <button class="detail-modal-close" id="detailModalClose" aria-label="Close listing details">×</button>
            <div class="detail-modal-content" id="detailModalContent"></div>
        </div>
    </div>


    <script>
        const STORAGE_KEY = "savedListings";

        const searchInput = document.getElementById("searchInput");
        const savedFilter = document.getElementById("savedFilter");
        const sellerFilter = document.getElementById("sellerFilter");
        const artistFilter = document.getElementById("artistFilter");
        const categoryFilter = document.getElementById("categoryFilter");
        const priceMinInput = document.getElementById("priceMinInput");
        const priceMaxInput = document.getElementById("priceMaxInput");
        const sortFilter = document.getElementById("sortFilter");
        const grid = document.getElementById("catalogGrid");
        const cards = Array.from(document.querySelectorAll("#catalogGrid .card"));
        const resultCount = document.getElementById("resultCount");
        const savedCount = document.getElementById("savedCount");
        const backToTop = document.getElementById("backToTop");
        const emptyState = document.getElementById("emptyState");
        const clearFiltersFromEmpty = document.getElementById("clearFiltersFromEmpty");

        const lightbox = document.getElementById("lightbox");
        const lightboxImage = document.getElementById("lightboxImage");
        const lightboxClose = document.getElementById("lightboxClose");
        const lightboxStage = document.getElementById("lightboxStage");
        const imageButtons = Array.from(document.querySelectorAll(".image-open"));
        const saveButtons = Array.from(document.querySelectorAll(".save-listing-button"));


        const loadingOverlay = document.getElementById("loadingOverlay");
        const loadingTitle = document.getElementById("loadingTitle");
        const loadingText = document.getElementById("loadingText");

        function setLoadingState(isOpen, title = "Preparing Image...", text = "Please wait while your download is generated.") {{
            loadingOverlay.classList.toggle("is-open", isOpen);
            loadingOverlay.setAttribute("aria-hidden", isOpen ? "false" : "true");
            loadingTitle.textContent = title;
            loadingText.textContent = text;
            document.body.style.overflow = isOpen ? "hidden" : "";
        }}

        function getSavedListings() {{
            try {{
                const raw = localStorage.getItem(STORAGE_KEY);
                const parsed = raw ? JSON.parse(raw) : [];
                return Array.isArray(parsed) ? parsed : [];
            }} catch (error) {{
                return [];
            }}
        }}

        function setSavedListings(savedIds) {{
            localStorage.setItem(STORAGE_KEY, JSON.stringify(savedIds));
        }}

        function isSaved(listingId) {{
            return getSavedListings().includes(listingId);
        }}

        function updateSavedButtons() {{
            const savedIds = getSavedListings();
            // Re-query each call so save buttons rendered inside the modal also sync.
            const allSaveButtons = document.querySelectorAll(".save-listing-button");
            allSaveButtons.forEach((button) => {{
                const id = button.dataset.listingId;
                const saved = savedIds.includes(id);
                button.classList.toggle("is-saved", saved);
                const isCornerHeart = button.classList.contains("corner-heart");
                button.textContent = isCornerHeart
                    ? (saved ? "♥" : "♡")
                    : (saved ? "♥ Saved" : "♡ Save Listing");
                button.setAttribute("aria-pressed", saved ? "true" : "false");
            }});
            savedCount.textContent = `${{savedIds.length}} saved`;
        }}

        function toggleSavedListing(listingId) {{
            const savedIds = getSavedListings();
            const index = savedIds.indexOf(listingId);

            if (index >= 0) {{
                savedIds.splice(index, 1);
            }} else {{
                savedIds.push(listingId);
            }}

            setSavedListings(savedIds);
            updateSavedButtons();

            
            if (savedFilter.value === "saved") {{
                applyFilters();
            }}
        }}

        function parsePriceFilter(input) {{
            // Treat blank / non-numeric as "no bound". Returns NaN for unbounded.
            const raw = (input && input.value || "").trim().replace(/[$,\s]/g, "");
            if (!raw) return NaN;
            const n = Number(raw);
            return isFinite(n) && n >= 0 ? n : NaN;
        }}

        function matchesPriceRange(cardPrice, minVal, maxVal) {{
            // cardPrice is the data-price attribute as a Number; -1 means
            // "price unknown / on request". Unknown listings only show when
            // no min/max bound is set (i.e. the filter is fully empty).
            const hasMin = !isNaN(minVal);
            const hasMax = !isNaN(maxVal);
            if (cardPrice < 0) return !hasMin && !hasMax;
            if (hasMin && cardPrice < minVal) return false;
            if (hasMax && cardPrice > maxVal) return false;
            return true;
        }}

        function sortCards(visibleCards) {{
            const mode = sortFilter.value;

            visibleCards.sort((a, b) => {{
                const priceA = Number(a.dataset.price || -1);
                const priceB = Number(b.dataset.price || -1);
                const newestA = Number(a.dataset.newest || 0);
                const newestB = Number(b.dataset.newest || 0);
                const artistA = (a.dataset.artist || "").toLowerCase();
                const artistB = (b.dataset.artist || "").toLowerCase();

                if (mode === "newest") return newestB - newestA;
                if (mode === "oldest") return newestA - newestB;

                if (mode === "priceDesc") {{
                    const safeA = priceA === -1 ? -Infinity : priceA;
                    const safeB = priceB === -1 ? -Infinity : priceB;
                    return safeB - safeA;
                }}

                if (mode === "priceAsc") {{
                    const safeA = priceA === -1 ? Infinity : priceA;
                    const safeB = priceB === -1 ? Infinity : priceB;
                    return safeA - safeB;
                }}

                if (mode === "artistAsc") return artistA.localeCompare(artistB);
                if (mode === "artistDesc") return artistB.localeCompare(artistA);

                return 0;
            }});

            visibleCards.forEach(card => grid.appendChild(card));
        }}

        function applyFilters() {{
            const search = searchInput.value.trim().toLowerCase();
            const savedOnly = savedFilter.value === "saved";
            const priceDropsOnly = savedFilter.value === "priceDrops";
            const seller = sellerFilter.value;
            const artist = artistFilter.value;
            const category = categoryFilter.value;
            const priceMin = parsePriceFilter(priceMinInput);
            const priceMax = parsePriceFilter(priceMaxInput);
            const savedIds = getSavedListings();

            let visibleCards = [];

            cards.forEach(card => {{
                const listingId = card.dataset.listingId || "";
                const sellerValue = card.dataset.seller || "";
                const artistValue = card.dataset.artist || "";
                const categoryValue = card.dataset.category || "";
                const cardPrice = Number(card.dataset.price || -1);
                const fullText = card.dataset.search || "";
                const isPriceDrop = card.dataset.priceDrop === "true";

                const matchesSearch = !search || fullText.includes(search);
                const matchesSaved = !savedOnly || savedIds.includes(listingId);
                const matchesPriceDrop = !priceDropsOnly || isPriceDrop;
                const matchesSeller = !seller || sellerValue === seller;
                const matchesArtist = !artist || artistValue === artist;
                const matchesCategory = !category || categoryValue === category;
                const matchesPrice = matchesPriceRange(cardPrice, priceMin, priceMax);

                const visible = matchesSearch && matchesSaved && matchesPriceDrop && matchesSeller && matchesArtist && matchesCategory && matchesPrice;
                card.classList.toggle("hidden", !visible);

                if (visible) {{
                    visibleCards.push(card);
                }}
            }});

            sortCards(visibleCards);
            resultCount.textContent = `${{visibleCards.length}} listing${{visibleCards.length === 1 ? "" : "s"}} shown`;
            emptyState.hidden = visibleCards.length > 0;
        }}

        function clearAllFilters() {{
            searchInput.value = "";
            savedFilter.value = "";
            sellerFilter.value = "";
            artistFilter.value = "";
            categoryFilter.value = "";
            if (priceMinInput) priceMinInput.value = "";
            if (priceMaxInput) priceMaxInput.value = "";
            sortFilter.value = "newest";
            applyFilters();
        }}



        


    

        function openLightbox(src, alt) {{
            lightboxImage.src = src;
            lightboxImage.alt = alt || "Artwork";
            lightbox.classList.add("is-open");
            lightbox.setAttribute("aria-hidden", "false");
            document.body.style.overflow = "hidden";
        }}

        function closeLightbox() {{
            lightbox.classList.remove("is-open");
            lightbox.setAttribute("aria-hidden", "true");
            lightboxImage.src = "";
            lightboxImage.alt = "";
            // Don't unlock body scroll if the detail modal is still open behind us.
            if (!detailModal.classList.contains("is-open")) {{
                document.body.style.overflow = "";
            }}
        }}

        // === Detail modal ===
        const detailModal = document.getElementById("detailModal");
        const detailModalContent = document.getElementById("detailModalContent");
        const detailModalClose = document.getElementById("detailModalClose");

        function openDetailModal(card) {{
            if (!card) return;
            const template = card.querySelector(".modal-content-template");
            if (!template) return;
            detailModalContent.innerHTML = "";
            detailModalContent.appendChild(template.content.cloneNode(true));
            detailModal.classList.add("is-open");
            detailModal.setAttribute("aria-hidden", "false");
            const stage = detailModal.querySelector(".detail-modal-stage");
            if (stage) stage.scrollTop = 0;
            document.body.style.overflow = "hidden";
            // Sync save button state for the freshly-cloned modal save button.
            updateSavedButtons();
        }}

        function closeDetailModal() {{
            detailModal.classList.remove("is-open");
            detailModal.setAttribute("aria-hidden", "true");
            detailModalContent.innerHTML = "";
            // Don't unlock body scroll if the lightbox is still open.
            if (!lightbox.classList.contains("is-open")) {{
                document.body.style.overflow = "";
            }}
        }}

        // Delegated click handler — covers buttons in cards and inside the modal.
        document.addEventListener("click", (event) => {{
            const imgBtn = event.target.closest(".image-open");
            if (imgBtn) {{
                event.preventDefault();
                openLightbox(imgBtn.dataset.fullsrc, imgBtn.dataset.alt);
                return;
            }}

            const saveBtn = event.target.closest(".save-listing-button");
            if (saveBtn) {{
                event.preventDefault();
                toggleSavedListing(saveBtn.dataset.listingId);
                return;
            }}

            const showMoreBtn = event.target.closest(".show-more-button");
            if (showMoreBtn) {{
                event.preventDefault();
                const card = showMoreBtn.closest(".card");
                openDetailModal(card);
                return;
            }}
        }});

        detailModalClose.addEventListener("click", closeDetailModal);

        detailModal.addEventListener("click", (event) => {{
            if (event.target === detailModal) {{
                closeDetailModal();
            }}
        }});

        lightboxClose.addEventListener("click", closeLightbox);

        lightbox.addEventListener("click", (event) => {{
            if (event.target === lightbox || event.target === lightboxStage) {{
                closeLightbox();
            }}
        }});

        document.addEventListener("keydown", (event) => {{
            if (event.key !== "Escape") return;
            if (lightbox.classList.contains("is-open")) {{
                closeLightbox();
                return;
            }}
            if (detailModal.classList.contains("is-open")) {{
                closeDetailModal();
            }}
        }});

        window.addEventListener("scroll", () => {{
            if (window.scrollY > 400) {{
                backToTop.style.display = "flex";
            }} else {{
                backToTop.style.display = "none";
            }}
        }});

        backToTop.addEventListener("click", () => {{
            window.scrollTo({{
                top: 0,
                behavior: "smooth"
            }});
        }});

        [searchInput, savedFilter, sellerFilter, artistFilter, categoryFilter, priceMinInput, priceMaxInput, sortFilter].forEach((el) => {{
            el.addEventListener("input", applyFilters);
            el.addEventListener("change", applyFilters);
        }});

        clearFiltersFromEmpty.addEventListener("click", clearAllFilters);

        const clearAllFiltersButton = document.getElementById("clearAllFiltersButton");
        if (clearAllFiltersButton) {{
            clearAllFiltersButton.addEventListener("click", clearAllFilters);
        }}

        updateSavedButtons();
        applyFilters();
    </script>

    <!-- Register the service worker so the catalog is installable as a PWA. -->
    <script>
        if ('serviceWorker' in navigator) {{
            window.addEventListener('load', function () {{
                navigator.serviceWorker
                    .register('/sw.js')
                    .catch(function () {{ /* swallow — non-blocking */ }});
            }});
        }}
    </script>
</body>
</html>"""


def main():
    import argparse

    parser = argparse.ArgumentParser()
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--csv", help="Local CSV file path. Can be raw Google Form export or already-normalized CSV.")
    source_group.add_argument("--sheet-url", help="Public Google Sheets CSV export URL.")
    source_group.add_argument("--sheet-id", help="Google Sheet ID. Use with --gid to fetch the public CSV export directly.")

    parser.add_argument("--gid", default="0", help="Google Sheet tab gid. Defaults to 0.")
    parser.add_argument("--images", default="", help="Optional local images directory fallback. Drive URLs are preferred.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--title", default="Art Catalog")
    parser.add_argument("--month-label", default="Monthly Art Listings")
    args = parser.parse_args()

    if args.sheet_id:
        data_source = build_google_sheet_csv_url(args.sheet_id, args.gid)
    elif args.sheet_url:
        data_source = args.sheet_url
    else:
        data_source = Path(args.csv).expanduser().resolve()

    images_path = Path(args.images).expanduser().resolve() if args.images else Path(".").resolve()
    output_path = Path(args.output).expanduser().resolve()

    data = load_data(data_source)

    html_text = generate_html(
        data=data,
        images_path=images_path,
        output_path=output_path,
        title=args.title,
        month_label=args.month_label,
    )

    guidelines_html = generate_guidelines_html(
        output_path=output_path,
        title=args.title,
    )

    about_html = generate_about_html(
        output_path=output_path,
        title=args.title,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html_text, encoding="utf-8")

    guidelines_path = output_path.parent / "guidelines.html"
    guidelines_path.write_text(guidelines_html, encoding="utf-8")

    about_path = output_path.parent / "about.html"
    about_path.write_text(about_html, encoding="utf-8")

    print(f"Loaded {len(data)} approved public listings.")
    print(f"Catalog generated: {output_path}")
    print(f"Guidelines generated: {guidelines_path}")
    print(f"About generated: {about_path}")


if __name__ == "__main__":
    main()
const destinations = {
  store: "https://bulbstore.laposabulb.com/",
  spotify: "",
  youtube: ""
};

const shopify = {
  endpoint: "https://udrkks-is.myshopify.com/api/2026-10/graphql.json",
  publicStorefrontToken: "f229756dc9d63b352f608be757067930"
};

const albums = [
  {
    folder: "LA POSA BULB",
    titles: [
      "Notti d'estate",
      "Fine del mondo",
      "Momento",
      "Resto",
      "Ragazza gatto",
      "Lato di te",
      "Carosello",
      "Torino"
    ]
  },
  {
    folder: "DEMONE CUSTODE - Edera",
    titles: ["Il bar dei cattivi", "Snob", "Non ho mai", "Ballo", "Demone custode"]
  }
].map(({ folder, titles }) => ({
  label: folder,
  tracks: titles.map((title, index) => ({
    label: title,
    url: "audio/" + encodeURIComponent(folder) + "/" + encodeURIComponent((index + 1) + " - " + title + ".wav")
  }))
}));

const screens = {
  home: {
    title: "LA POSA BULB",
    entries: [
      { label: "Link", screen: "links", description: "visualizza link utili" },
      { label: "La Posa Store", screen: "store", description: "visualizza i prodotti su La Posa Store" },
      { label: "Ascolta", screen: "albums", description: "se anche tu odi i servizi di streaming" }
    ]
  },
  links: {
    title: "Link",
    entries: [
      { label: "Spotify", url: destinations.spotify },
      { label: "YouTube", url: destinations.youtube }
    ]
  },
  albums: { title: "Album", entries: albums },
  music: { title: "", entries: [] },
  store: { title: "LA POSA STORE", entries: [] },
  product: { title: "LA POSA STORE", entries: [{ label: "apri LA POSA STORE" }] }
};

const device = document.querySelector(".ipod");
const title = document.querySelector("#screen-title");
const titleText = title.querySelector("span");
const list = document.querySelector("#entries");
const status = document.querySelector("#status");
const audio = document.querySelector("#music");
const player = document.querySelector(".music-player");
const nowPlaying = document.querySelector("#now-playing");
const playbackState = document.querySelector("#playback-state");
const position = document.querySelector("#track-position");
const trackTime = document.querySelector("#track-time");
const playButton = device.querySelector(".play");
const detail = document.querySelector(".product-detail");
const productImage = detail.querySelector(".product-image");
const productName = detail.querySelector(".product-name");
const productPrice = detail.querySelector(".product-price");
const wheel = document.querySelector(".wheel");
const thumbnails = new Map();
let screen = "home";
let selected = 0;
let activeProduct;
let catalogRequest;
let playingTrack = -1;
let activeAlbum;
let playingAlbum;

function formatTime(seconds) {
  const total = Math.floor(seconds);
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

function updatePlayer() {
  const track = playingAlbum?.tracks[playingTrack];
  const hidden = !track;
  const visibilityChanged = player.hidden !== hidden;
  player.hidden = hidden;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  playbackState.dataset.state = audio.ended ? "ended" : audio.paused ? "paused" : "playing";
  playbackState.textContent = audio.ended ? "Terminato ·" : "";
  playbackState.setAttribute("aria-label", audio.ended ? "Terminato" : audio.paused ? "In pausa" : "In riproduzione");
  nowPlaying.textContent = track?.label ?? "";
  position.max = duration || 1;
  position.value = duration ? audio.currentTime : 0;
  trackTime.textContent = formatTime(audio.currentTime) + " / " + formatTime(duration);
  playButton.setAttribute("aria-label", track || screen === "music" ? "Riproduci o metti in pausa" : "Apri la voce selezionata");
  if (visibilityChanged) keepSelectionVisible();
}

async function playTrack(index, album = activeAlbum) {
  const track = album?.tracks[index];
  if (!track) return;
  if (playingAlbum !== album || playingTrack !== index) {
    playingAlbum = album;
    playingTrack = index;
    audio.src = track.url;
  } else if (!audio.paused) {
    audio.pause();
    return;
  } else if (audio.ended) {
    audio.currentTime = 0;
  }
  if (screen === "music") status.textContent = "";
  const source = audio.src;
  try {
    await audio.play();
  } catch (error) {
    if (error.name !== "AbortError" && audio.src === source && screen === "music") {
      status.textContent = "Impossibile riprodurre il brano";
    }
  }
}

for (const event of ["loadedmetadata", "durationchange", "timeupdate", "playing", "pause", "emptied", "error"]) {
  audio.addEventListener(event, updatePlayer);
}
function playAdjacentTrack(index) {
  if (!playingAlbum?.tracks[index]) return;
  playTrack(index, playingAlbum);
  if (screen === "music" && activeAlbum === playingAlbum) {
    selected = index;
    render();
  }
}

audio.addEventListener("ended", () => {
  playAdjacentTrack(playingTrack + 1);
  updatePlayer();
});

productImage.addEventListener("error", () => {
  productImage.hidden = true;
});

async function loadProducts() {
  const products = [];
  const signal = AbortSignal.timeout(10000);
  const headers = { "Content-Type": "application/json" };
  if (shopify.publicStorefrontToken) {
    headers["X-Shopify-Storefront-Access-Token"] = shopify.publicStorefrontToken;
  }
  const query = `
    query Catalog($after: String) {
      products(first: 50, after: $after) {
        nodes {
          title
          handle
          featuredImage { url }
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  let after = null;

  do {
    const response = await fetch(shopify.endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ query, variables: { after } })
    });
    if (!response.ok) throw new Error("Catalogo non disponibile");

    const result = await response.json();
    if (result.errors?.length) throw new Error("Catalogo non disponibile");
    const { nodes, pageInfo } = result.data.products;
    for (const product of nodes) {
      products.push({
        label: product.title,
        url: new URL("products/" + encodeURIComponent(product.handle), destinations.store).href,
        image: product.featuredImage?.url,
        priceRange: product.priceRange
      });
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  return products;
}

async function refreshCatalog() {
  status.textContent = "Caricamento…";
  if (catalogRequest) return;
  catalogRequest = loadProducts();
  try {
    const products = await catalogRequest;
    const selectedUrl = screens.store.entries[selected]?.url;
    screens.store.entries = products;
    thumbnails.clear();
    if (screen === "store") {
      selected = Math.max(0, products.findIndex(product => product.url === selectedUrl));
      render();
      status.textContent = products.length ? "" : "Nessun prodotto disponibile";
    }
  } catch {
    if (screen === "store") status.textContent = "Catalogo non disponibile";
  } finally {
    catalogRequest = undefined;
  }
}

function thumbnailFor(product) {
  if (thumbnails.has(product)) return thumbnails.get(product);

  const canvas = document.createElement("canvas");
  canvas.className = "product-thumbnail";
  canvas.width = 16;
  canvas.height = 16;
  canvas.setAttribute("aria-hidden", "true");
  thumbnails.set(product, canvas);

  if (product.image) {
    const image = new Image();
    image.onload = () => {
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      canvas.getContext("2d").drawImage(image,
        (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2,
        size, size, 0, 0, canvas.width, canvas.height);
    };
    image.src = new URL(product.image, destinations.store).href;
  }
  return canvas;
}

function updateTitleScroll() {
  const distance = titleText.scrollWidth - title.clientWidth;
  title.classList.toggle("title-overflow", distance > 0);
  title.style.setProperty("--title-offset", -distance + "px");
  title.style.setProperty("--title-duration", Math.max(2.5, distance / 22) + "s");
}

const titleObserver = new ResizeObserver(updateTitleScroll);
titleObserver.observe(title);
titleObserver.observe(titleText);

function render() {
  const current = screens[screen];
  if (titleText.textContent !== current.title) {
    titleText.textContent = current.title;
    updateTitleScroll();
  }
  updatePlayer();
  if (screen === "home") {
    const entry = current.entries[selected];
    status.textContent = entry.description ?? entry.label;
  }
  detail.hidden = screen !== "product";
  if (!detail.hidden) {
    productName.textContent = activeProduct.label;
    const priceRange = activeProduct.priceRange;
    productPrice.hidden = !priceRange;
    if (priceRange) {
      const { amount, currencyCode } = priceRange.minVariantPrice;
      const price = new Intl.NumberFormat("it-IT", {
        style: "currency",
        currency: currencyCode
      }).format(Number(amount));
      const hasDifferentPrices = Number(priceRange.maxVariantPrice.amount) > Number(amount);
      productPrice.textContent = hasDifferentPrices ? "Da " + price : price;
    }
    productImage.hidden = !activeProduct.image;
    if (activeProduct.image && productImage.getAttribute("src") !== activeProduct.image) {
      productImage.src = activeProduct.image;
    } else if (activeProduct.image && productImage.complete && !productImage.naturalWidth) {
      productImage.hidden = true;
    }
  }
  list.classList.toggle("products", screen === "store");
  list.replaceChildren(...current.entries.map((entry, index) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.label;
    const arrow = document.createElement("span");
    arrow.textContent = "›";
    arrow.className = "entry-arrow";
    arrow.setAttribute("aria-hidden", "true");
    if (index === selected) item.setAttribute("aria-current", "true");
    if (screen === "store") item.append(thumbnailFor(entry));
    item.append(name, arrow);
    return item;
  }));
  keepSelectionVisible();
}

function keepSelectionVisible() {
  const row = list.children[selected];
  if (!row) return;
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  const bottom = row.offsetTop + row.offsetHeight;
  if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

function move(step) {
  if (screen === "product") return;
  const count = screens[screen].entries.length;
  if (!count) return;
  selected = Math.max(0, Math.min(count - 1, selected + step));
  render();
  if (screen === "links") status.textContent = screens.links.entries[selected].label;
}

function openSelection() {
  if (screen === "product") {
    window.open(activeProduct.url, "_blank", "noopener,noreferrer");
    return;
  }
  const entry = screens[screen].entries[selected];
  if (!entry) return;
  if (screen === "albums") {
    if (activeAlbum !== entry) {
      activeAlbum = entry;
      screens.music.title = entry.label;
      screens.music.entries = entry.tracks;
    }
    screen = "music";
    selected = activeAlbum === playingAlbum ? playingTrack : 0;
    status.textContent = entry.tracks.length ? "" : "Brani in arrivo";
    render();
    return;
  }
  if (screen === "music") {
    playTrack(selected);
    return;
  }
  if (screen === "store") {
    activeProduct = entry;
    screen = "product";
    selected = 0;
    status.textContent = "";
    render();
    return;
  }
  if (entry.screen) {
    screen = entry.screen;
    selected = screen === "albums" && activeAlbum ? albums.indexOf(activeAlbum) : 0;
    render();
    status.textContent = "";
    if (screen === "store") refreshCatalog();
    return;
  }
  if (entry.url) {
    window.location.assign(entry.url);
    return;
  }
  status.textContent = entry.unavailable ?? "Link in arrivo";
}

function goBack() {
  if (screen === "home") return;
  if (screen === "music") {
    screen = "albums";
    selected = albums.indexOf(activeAlbum);
  } else if (screen === "product") {
    screen = "store";
    selected = Math.max(0, screens.store.entries.findIndex(entry => entry.url === activeProduct.url));
    activeProduct = undefined;
  } else {
    screen = "home";
    selected = 0;
  }
  status.textContent = "";
  render();
}

function useTrackButton(step) {
  if (screen !== "music" || activeAlbum !== playingAlbum || playingTrack < 0 || audio.paused) {
    move(step);
    return;
  }
  if (step < 0 && (audio.currentTime > 2 || playingTrack === 0)) {
    audio.currentTime = 0;
    selected = playingTrack;
    render();
    return;
  }
  playAdjacentTrack(playingTrack + step);
}

device.querySelector(".previous").addEventListener("click", () => useTrackButton(-1));
device.querySelector(".next").addEventListener("click", () => useTrackButton(1));
device.querySelector(".menu").addEventListener("click", goBack);
device.querySelector(".select").addEventListener("click", openSelection);
let stopTimer;
let didLongPress = false;

playButton.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0) return;
  didLongPress = false;
  if (playingTrack < 0) return;
  stopTimer = setTimeout(() => {
    didLongPress = true;
    playingAlbum = undefined;
    playingTrack = -1;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    updatePlayer();
  }, 2000);
});

for (const event of ["pointerup", "pointercancel", "pointerleave"]) {
  playButton.addEventListener(event, () => clearTimeout(stopTimer));
}
playButton.addEventListener("contextmenu", event => event.preventDefault());

playButton.addEventListener("click", event => {
  if (didLongPress && event.detail > 0) return;
  if (playingTrack >= 0) {
    playTrack(playingTrack, playingAlbum);
  } else {
    openSelection();
  }
});

let pointer = null;
let lastAngle = 0;
let rotation = 0;
const stepAngle = Math.PI / 5;

function angleAt(event) {
  const bounds = wheel.getBoundingClientRect();
  return Math.atan2(event.clientY - bounds.top - bounds.height / 2,
                    event.clientX - bounds.left - bounds.width / 2);
}

wheel.addEventListener("pointerdown", event => {
  if (pointer !== null || event.button !== 0) return;
  pointer = event.pointerId;
  lastAngle = angleAt(event);
  rotation = 0;
  wheel.setPointerCapture(pointer);
});

wheel.addEventListener("pointermove", event => {
  if (pointer !== event.pointerId) return;
  const angle = angleAt(event);
  const change = angle - lastAngle;
  rotation += Math.atan2(Math.sin(change), Math.cos(change));
  lastAngle = angle;
  if (Math.abs(rotation) < stepAngle) return;
  const steps = Math.trunc(rotation / stepAngle);
  rotation -= steps * stepAngle;
  move(steps);
});

wheel.addEventListener("lostpointercapture", event => {
  if (pointer === event.pointerId) pointer = null;
});

render();

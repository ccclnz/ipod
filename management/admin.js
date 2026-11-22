const forms = Array.from(document.forms);
const statusLine = document.querySelector("#status");
const defaults = [["home","Menu principale"],["links","Link"],["listen","Ascolta"],["songs","Brani"],["genres","Generi"],["playlists","Playlist"],["albums","Album"],["artists","Artisti"],["store","La Posa Store"]];
const editor = document.querySelector('form[data-action="edit-track"]');
let playlistChoices = [];
let tracks = new Map();
let ready = false;

function showTrack() {
  const track = tracks.get(editor.elements.track.value);
  if (!track) return;
  editor.elements.artist.value = track.original.artist;
  editor.elements.album.value = track.original.album;
  editor.elements.genre.value = track.original.genre;
  const container = document.querySelector("#memberships");
  container.replaceChildren(...playlistChoices.map(playlist => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "playlists";
    input.value = playlist.id;
    input.checked = track.original.playlists.includes(playlist.id);
    label.append(input, playlist.label);
    return label;
  }));
  if (!playlistChoices.length) container.textContent = "Nessuna playlist creata.";
}
editor.elements.track.addEventListener("change", showTrack);

function busy(value) {
  for (const form of forms) form.querySelector("button").disabled = value;
}

function options(name, values, current) {
  for (const select of document.querySelectorAll('select[name="' + name + '"]')) {
    const previous = current ?? select.value;
    select.replaceChildren(...values.map(([id, label]) => new Option(label, id)));
    if (values.some(([id]) => id === previous)) select.value = previous;
  }
}

async function load() {
  const response = await fetch("/api/catalog");
  if (!response.ok) throw new Error("Catalogo non disponibile. Ricarica la pagina.");
  const {artists, albums, playlists = [], start} = await response.json();
  const names = new Map(artists.map(a => [a.id, a.label]));
  const records = albums.map(a => [a.id, a.label + " · " + names.get(a.artistId)]);
  options("artist", Array.from(names));
  options("album", records);
  options("start", [...defaults, ...records], start);
  playlistChoices = playlists;
  tracks = new Map(albums.flatMap(album => album.tracks.map(track => {
    const artist = track.artistId ?? album.artistId;
    const original = {
      artist, album: album.id, genre: track.genre ?? "",
      playlists: playlists.filter(p => p.tracks.includes(track.url)).map(p => p.id)
    };
    return [track.url, { label: [track.label, album.label, names.get(artist)].join(" · "), original }];
  })));
  options("track", Array.from(tracks, ([url, track]) => [url, track.label]));
  options("playlist", playlists.map(p => [p.id, p.label]));
  showTrack();
  const genres = new Set(Array.from(tracks.values(), track => track.original.genre).filter(Boolean));
  document.querySelector("#genres").replaceChildren(...Array.from(genres, name => new Option(name)));
  document.querySelector("#library").replaceChildren(...albums.map((a, i) =>
    trackList(records[i][1], a.tracks.map(t => t.label))
  ));
  document.querySelector("#playlist-library").replaceChildren(...playlists.map(p =>
    trackList(p.label, p.tracks.map(url => tracks.get(url)?.label).filter(Boolean))
  ));
}

function trackList(title, labels) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = title + " (" + labels.length + ")";
  const list = document.createElement("ol");
  for (const label of labels) {
    const item = document.createElement("li");
    item.textContent = label;
    list.append(item);
  }
  details.append(summary, list);
  return details;
}

for (const form of forms) form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!ready) return;
  busy(true);
  const action = form.dataset.action;
  const fields = new FormData(form);
  const data = Object.fromEntries(fields);
  if (action === "edit-track") {
    data.playlists = fields.getAll("playlists");
    data.original = tracks.get(data.track).original;
  }
  let url = "/api/" + action;
  statusLine.textContent = action === "track" ? "Caricamento del brano…" : "Salvataggio…";
  let saved = false;
  try {
    let body;
    if (action === "track") {
      if (data.file.size > 128 * 1024 * 1024) throw new Error("Il file supera 128 MiB.");
      url += "?" + new URLSearchParams({label: data.label, album: data.album, genre: data.genre});
      body = data.file;
    } else {
      body = JSON.stringify(data);
    }
    const response = await fetch(url, {method: "POST", body});
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Salvataggio non riuscito. Riprova.");
    }
    saved = true;
    if (form.elements.label) form.elements.label.value = "";
    if (form.elements.file) form.elements.file.value = "";
    await load();
    statusLine.textContent = {"edit-track":"Modifiche al brano pubblicate.",playlist:"Playlist creata.","playlist-track":"Brano aggiunto alla playlist.",artist:"Artista aggiunto.",album:"Album pubblicato.",track:"Brano pubblicato.",start:"Schermata iniziale salvata."}[action];
  } catch (error) {
    statusLine.textContent = saved ? "Salvato. Ricarica per aggiornare il catalogo." : error.message;
  } finally {
    busy(false);
  }
});
busy(true);
load().then(() => { ready = true; busy(false); statusLine.textContent = ""; })
  .catch(error => { statusLine.textContent = error.message; });

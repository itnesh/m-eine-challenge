# M-eine Challenge

Wöchentliche Team-Challenge (ABCD-Jagd, Stadt–Land–Fluss, Stiller Held) mit Live-Sync für alle Teilnehmenden.

## Architektur

- **Hosting:** GitHub Pages (statische Dateien aus diesem Repo)
- **Live-Daten:** Firebase Firestore, ein Dokument `teams/{teamcode}`
- **Zugriff:** Teamcode + Namenswahl, kein Passwort. Der Teamcode steht nur in den Firestore Rules (Firebase Console), nicht im Code.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `styles.css` | UI |
| `app.js` | Spiellogik, Rendering |
| `store.js` | Datenanbindung Firestore (bzw. Mock mit `?mock`) |
| `firebase-config.js` | Öffentliche Firebase Web-App-Konfiguration |
| `firestore.rules` | Vorlage Security Rules (`TEAMCODE` ersetzen, in der Console einfügen) |

## Einrichtung

1. Firebase-Projekt anlegen, Firestore aktivieren (`europe-west6`, production mode).
2. Web-App registrieren, Werte in `firebase-config.js` eintragen.
3. Inhalt von `firestore.rules` in Firebase Console > Firestore > Rules einfügen, `TEAMCODE` ersetzen, **Publish**.
4. GitHub Pages: Settings > Pages > Branch `main`, Ordner `/ (root)`.

## Nutzung

- Link fürs Team: `https://<user>.github.io/m-eine-challenge/?team=<teamcode>`
  (der Code wird im Browser gespeichert und aus der Adresszeile entfernt)
- Erste Woche: Spiel und Spielleitung auf der Startseite unter "Startkonfiguration" wählen.

## Lokal testen (ohne Firebase)

```
python -m http.server 8080
```
Dann mehrere Tabs mit `http://localhost:8080/?mock&team=test` öffnen. Im Testmodus ist das Login pro Tab getrennt.

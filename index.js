require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const CONVERSATIONS_FILE = "./conversations.json";
const PENDING_POSTS_FILE = "./pending_posts.json";
const USER_IMAGES_FILE = "./user_images.json";
const SPAM_BANS_FILE = "./spam_bans.json";

let spamBans = {};

try {
    if (fs.existsSync(SPAM_BANS_FILE)) {
        spamBans = JSON.parse(
            fs.readFileSync(SPAM_BANS_FILE, "utf8").replace(/^\uFEFF/, "")
        );
    }
} catch (error) {
    console.error("Błąd odczytu spam_bans.json:", error);
    spamBans = {};
}

function saveSpamBans() {
    fs.writeFileSync(
        SPAM_BANS_FILE,
        JSON.stringify(spamBans, null, 2),
        "utf8"
    );
}

// =====================================================
// ANTYSPAM / LIMITY UŻYTKOWNIKÓW
// =====================================================

const spamUsers = new Map();
const globalMessages = [];

const SPAM_CONFIG = {
    minInterval: 3000,
    max10min: 25,
    max1hour: 50,
    max24hours: 80,
    duplicateWindow: 30000,
    duplicateLimit: 5,
    burstWindow: 30000,
    burstLimit: 10,
    fiveMinuteWindow: 300000,
    fiveMinuteLimit: 30,
    globalWarning: 500,
    globalBlock: 1000
};

function cleanupTimes(times, windowMs, now) {
    return times.filter(timestamp => now - timestamp <= windowMs);
}

function registerSpamStrike(senderId, user, now) {
    user.strikes++;
    console.warn(`ANTYSPAM: ${senderId} - strike ${user.strikes}`);

    if (user.strikes >= 3) {
        spamBans[senderId] = {
            bannedUntil: now + 7 * 24 * 60 * 60000,
            strikes: user.strikes,
            reason: "spam"
        };
        saveSpamBans();
        console.warn(`ANTYSPAM: ${senderId} - BAN 7 DNI.`);
        return true;
    }
    return false;
}

function checkPermanentSpamBan(senderId) {
    const now = Date.now();
    const ban = spamBans[senderId];

    if (!ban) return { banned: false };

    if (ban.bannedUntil && ban.bannedUntil > now) {
        return {
            banned: true,
            remaining: Math.ceil((ban.bannedUntil - now) / 1000),
            strikes: ban.strikes || 0
        };
    }

    delete spamBans[senderId];
    saveSpamBans();
    return { banned: false };
}

function checkSpam(senderId, message, imageUrl) {
    const now = Date.now();
    const existingUser = spamUsers.get(senderId);

    if (
        existingUser &&
        existingUser.lastAcceptedAt &&
        now - existingUser.lastAcceptedAt < SPAM_CONFIG.minInterval
    ) {
        console.warn(
            `ANTYSPAM: ${senderId} - ` +
            `wiadomość zbyt szybko. ` +
            `Odstęp: ${now - existingUser.lastAcceptedAt} ms`
        );
        return { allowed: false, reason: "too_fast" };
    }

    let user = spamUsers.get(senderId);
    if (!user) {
        user = {
            times: [],
            blockedUntil: 0,
            lastMessageKey: "",
            duplicateTimes: [],
            strikes: 0,
            lastAcceptedAt: 0
        };
        spamUsers.set(senderId, user);
    }

    if (user.blockedUntil > now) {
        return {
            allowed: false,
            reason: "blocked",
            remaining: Math.ceil((user.blockedUntil - now) / 1000)
        };
    }

    user.times = cleanupTimes(user.times, 86400000, now);
    user.duplicateTimes = cleanupTimes(
        user.duplicateTimes,
        SPAM_CONFIG.duplicateWindow,
        now
    );

    const messageKey = JSON.stringify({
        message: (message || "").trim().toLowerCase(),
        image: imageUrl || ""
    });

    if (user.lastMessageKey === messageKey) {
        user.duplicateTimes.push(now);
    } else {
        user.lastMessageKey = messageKey;
        user.duplicateTimes = [now];
    }

    if (user.duplicateTimes.length >= SPAM_CONFIG.duplicateLimit) {
        registerSpamStrike(senderId, user, now);
        const blockMinutes =
            user.strikes >= 3 ? 1440 :
            user.strikes === 2 ? 120 : 30;
        user.blockedUntil = now + blockMinutes * 60000;
        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `identyczne wiadomości. Blokada ${blockMinutes} min.`
        );
        return { allowed: false, reason: "duplicate" };
    }

    const lastMessage = user.times[user.times.length - 1];
    if (lastMessage && now - lastMessage < SPAM_CONFIG.minInterval) {
        return { allowed: false, reason: "too_fast" };
    }

    const last10min = user.times.filter(t => now - t <= 600000);
    const lastHour = user.times.filter(t => now - t <= 3600000);

    if (last10min.length >= SPAM_CONFIG.max10min) {
        registerSpamStrike(senderId, user, now);
        user.blockedUntil = now + (
            user.strikes >= 3 ? 86400000 :
            user.strikes === 2 ? 120 * 60000 : 30 * 60000
        );
        console.log(`ANTYSPAM: ${senderId} - przekroczono 25/10 min.`);
        return { allowed: false, reason: "10min" };
    }

    if (lastHour.length >= SPAM_CONFIG.max1hour) {
        registerSpamStrike(senderId, user, now);
        user.blockedUntil = now + (
            user.strikes >= 3 ? 86400000 : 3600000
        );
        console.log(`ANTYSPAM: ${senderId} - przekroczono 50/h.`);
        return { allowed: false, reason: "hour" };
    }

    if (user.times.length >= SPAM_CONFIG.max24hours) {
        registerSpamStrike(senderId, user, now);
        user.blockedUntil = now + 86400000;
        console.log(`ANTYSPAM: ${senderId} - przekroczono 150/24h.`);
        return { allowed: false, reason: "day" };
    }

    const burst = user.times.filter(
        t => now - t <= SPAM_CONFIG.burstWindow
    );
    if (burst.length >= SPAM_CONFIG.burstLimit) {
        registerSpamStrike(senderId, user, now);
        user.blockedUntil = now + 10 * 60000;
        console.log(`ANTYSPAM: ${senderId} - 10 wiadomości / 30 sekund.`);
        return { allowed: false, reason: "burst" };
    }

    const fiveMinutes = user.times.filter(
        t => now - t <= SPAM_CONFIG.fiveMinuteWindow
    );
    if (fiveMinutes.length >= SPAM_CONFIG.fiveMinuteLimit) {
        registerSpamStrike(senderId, user, now);
        user.blockedUntil = now + 60 * 60000;
        console.log(`ANTYSPAM: ${senderId} - 30 wiadomości / 5 minut.`);
        return { allowed: false, reason: "5min" };
    }

    user.lastAcceptedAt = now;
    user.times.push(now);
    return { allowed: true };
}

// =====================================================
// GLOBALNY BEZPIECZNIK AI
// =====================================================

function checkGlobalLimit() {
    const now = Date.now();

    while (globalMessages.length && now - globalMessages[0] > 3600000) {
        globalMessages.shift();
    }

    if (globalMessages.length >= SPAM_CONFIG.globalBlock) {
        console.error("!!! GLOBALNY LIMIT AI !!!");
        return false;
    }

    globalMessages.push(now);

    if (globalMessages.length >= SPAM_CONFIG.globalWarning) {
        console.warn(
            `UWAGA: ${globalMessages.length} wiadomości AI w ciągu godziny.`
        );
    }
    return true;
}

// =====================================================
// KATEGORIE SPOTTED
// =====================================================

const CATEGORIES = {
    wypadek_zdarzenie: {
        label: "🚨 WYPADEK / ZDARZENIE",
        hashtag: "#WypadekZdarzenie"
    },
    zwierzeta: {
        label: "🐾 ZAGINIONE / ZNALEZIONE ZWIERZĘ",
        hashtag: "#ZaginioneZwierzeta"
    },
    droga: {
        label: "🚧 UTRUDNIENIA NA DRODZE",
        hashtag: "#UtrudnieniaNaDrodze"
    },
    osoba: {
        label: "🔎 ZAGINĄŁ / ZNALEZIONO OSOBĘ",
        hashtag: "#ZaginionaOsoba"
    },
    informacja: {
        label: "📢 WAŻNA INFORMACJA",
        hashtag: "#WaznaInformacja"
    },
    firma: {
        label: "🏪 FIRMA / REKLAMA",
        hashtag: "#FirmaReklama"
    },
    ogloszenia: {
        label: "📢 OGŁOSZENIA",
        hashtag: "#Ogloszenia"
    },
    zdjecie_film: {
        label: "📸 ZDJĘCIE / FILM",
        hashtag: "#ZdjecieFilm"
    }
};

function getCategory(category) {
    return CATEGORIES[category] || CATEGORIES.ogloszenia;
}

function extractCategory(text) {
    if (!text) return "ogloszenia";
    const match = text.match(
        /\[KATEGORIA\]\s*([^\s\]]+)\s*\[\/KATEGORIA\]/i
    );
    if (!match) return "ogloszenia";
    const value = match[1].trim().toLowerCase();
    return CATEGORIES[value] ? value : "ogloszenia";
}

// =====================================================
// PAMIĘĆ
// =====================================================

function loadJSON(file) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        }
    } catch (error) {
        console.error("Błąd odczytu:", file, error);
    }
    return {};
}

function saveJSON(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
        console.error("Błąd zapisu:", file, error);
    }
}

let conversations = loadJSON(CONVERSATIONS_FILE);
let pendingPosts = loadJSON(PENDING_POSTS_FILE);
let userImages = loadJSON(USER_IMAGES_FILE);

// =====================================================
// FACEBOOK MESSENGER
// =====================================================

async function sendFacebookMessage(recipientId, text) {
    const url =
        `https://graph.facebook.com/v23.0/${process.env.PAGE_ID}/messages`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: text },
            access_token: process.env.PAGE_ACCESS_TOKEN
        })
    });

    const data = await response.json();
    console.log("Facebook Messenger odpowiedział:", data);

    if (!response.ok) {
        throw new Error(JSON.stringify(data));
    }
}

// =====================================================
// PUBLIKOWANIE POSTA NA FACEBOOKU
// =====================================================

async function publishFacebookPost(
    text,
    imageUrl = null,
    category = "ogloszenia"
) {
    const pageId = process.env.PAGE_ID;
    const accessToken = process.env.PAGE_ACCESS_TOKEN;

    if (!pageId) throw new Error("Brak PAGE_ID w pliku .env");
    if (!accessToken) throw new Error("Brak PAGE_ACCESS_TOKEN w pliku .env");

    const categoryInfo = getCategory(category);
    const facebookText =
        `${categoryInfo.label}\n\n${text}\n\n${categoryInfo.hashtag} #SpottedBrodnica`;

    if (imageUrl) {
        console.log("========================================");
        console.log("Publikowanie posta ze zdjęciem...");
        console.log("Kategoria:", categoryInfo.label);
        console.log("URL zdjęcia:", imageUrl);

        let imageResponse;
        try {
            imageResponse = await fetch(imageUrl);
        } catch (error) {
            console.error("Błąd pobierania zdjęcia:", error);
            throw new Error("Nie udało się pobrać zdjęcia z Messengera.");
        }

        if (!imageResponse.ok) {
            console.log(
                "Pierwsza próba pobrania zdjęcia nieudana.",
                "HTTP:", imageResponse.status
            );
            try {
                imageResponse = await fetch(imageUrl, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    }
                });
            } catch (error) {
                console.error(
                    "Druga próba pobrania zdjęcia nieudana:",
                    error
                );
            }
        }

        if (!imageResponse.ok) {
            throw new Error(
                `Nie udało się pobrać zdjęcia z Messengera. HTTP ${imageResponse.status}`
            );
        }

        const imageBuffer = await imageResponse.arrayBuffer();
        const contentType =
            imageResponse.headers.get("content-type") || "image/jpeg";

        console.log("Typ zdjęcia:", contentType);
        console.log("Rozmiar zdjęcia:", imageBuffer.byteLength, "bajtów");

        const blob = new Blob([imageBuffer], { type: contentType });
        const formData = new FormData();

        formData.append("source", blob, "spotted.jpg");
        formData.append("message", facebookText);
        formData.append("access_token", accessToken);

        const url =
            `https://graph.facebook.com/v23.0/${pageId}/photos`;

        console.log("Wysyłam zdjęcie do Facebooka...");

        const response = await fetch(url, {
            method: "POST",
            body: formData
        });

        const data = await response.json();
        console.log("Facebook odpowiedział:", data);

        if (!response.ok || data.error) {
            throw new Error(JSON.stringify(data));
        }

        console.log("========================================");
        console.log("POST ZE ZDJĘCIEM OPUBLIKOWANY!");
        console.log("ID:", data.id);
        console.log("========================================");

        return data;
    }

    console.log("Publikuję post tekstowy...");
    console.log("Kategoria:", categoryInfo.label);

    const url =
        `https://graph.facebook.com/v23.0/${pageId}/feed`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
            message: facebookText,
            access_token: accessToken
        })
    });

    const data = await response.json();
    console.log("Facebook publikacja posta:", data);

    if (!response.ok || data.error) {
        throw new Error(JSON.stringify(data));
    }

    console.log("POST TEKSTOWY OPUBLIKOWANY!");
    return data;
}

// =====================================================
// SPRAWDZENIE "TAK"
// =====================================================

function isApproval(text) {
    if (!text) return false;

    const value = text
        .trim()
        .toLowerCase()
        .replace(/[.!?,]/g, "")
        .replace(/\s+/g, " ");

    const approvals = [
        "tak", "yes", "zatwierdzam", "zatwierdzone", "publikuj",
        "opublikuj", "możesz publikować", "mozna publikowac",
        "można publikować", "zgadzam się", "zgadzam sie", "ok", "okej",
        "okey", "dobrze", "tak zatwierdzam", "tak publikuj",
        "tak opublikuj", "tak można", "tak mozna", "tak zgadzam się",
        "tak zgadzam sie"
    ];

    return approvals.includes(value);
}

// =====================================================
// WYCIĄGANIE OGŁOSZENIA
// =====================================================

function extractPost(text) {
    if (!text) return null;
    const match = text.match(
        /\[OGLOSZENIE\]([\s\S]*?)\[\/OGLOSZENIE\]/i
    );
    if (!match) return null;
    return match[1].trim();
}

// =====================================================
// STRONA GŁÓWNA
// =====================================================

app.get("/", (req, res) => {
    res.send("Spotted Brodnica AI działa!");
});

// =====================================================
// FACEBOOK WEBHOOK - WERYFIKACJA
// =====================================================

app.get("/webhook", (req, res) => {
    const VERIFY_TOKEN = "brodnica1234";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Facebook zweryfikował webhook!");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// =====================================================
// FACEBOOK WEBHOOK - WIADOMOŚCI
// =====================================================

app.post("/webhook", async (req, res) => {
    console.log("========================================");
    console.log("Otrzymano wiadomość z Facebooka:");
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const event = req.body?.entry?.[0]?.messaging?.[0];
        if (!event) {
            res.sendStatus(200);
            return;
        }

        const message = event?.message?.text;
        const imageUrl = event?.message?.attachments?.find(
            attachment => attachment.type === "image"
        )?.payload?.url;
        const senderId = event?.sender?.id;

        console.log("ID użytkownika:", senderId);
        console.log("Treść:", message || "(brak)");
        console.log("Zdjęcie:", imageUrl || "(brak)");

        if (!senderId) {
            res.sendStatus(200);
            return;
        }

        // =========================================
        // ANTYSPAM
        // =========================================

        const spamBan = checkPermanentSpamBan(senderId);
        if (spamBan.banned) {
            console.warn(
                `ANTYSPAM: ${senderId} - ` +
                `AKTYWNY BAN. Pozostało ${spamBan.remaining} sekund.`
            );
            res.sendStatus(200);
            return;
        }

        const spamCheck = checkSpam(senderId, message, imageUrl);
        if (!spamCheck.allowed) {
            console.log(
                "ANTYSPAM - odrzucono wiadomość:",
                senderId,
                spamCheck.reason
            );
            res.sendStatus(200);
            return;
        }

        // =========================================
        // GLOBALNY LIMIT AI
        // =========================================

        if (!checkGlobalLimit()) {
            console.error(
                "GLOBALNY LIMIT - AI NIE ZOSTAŁO URUCHOMIONE."
            );
            res.sendStatus(200);
            return;
        }

        // =========================================
        // ZAPISUJEMY OSTATNIE ZDJĘCIE
        // =========================================

        if (imageUrl) {
            userImages[senderId] = imageUrl;
            saveJSON(USER_IMAGES_FILE, userImages);
            console.log("Zapamiętano zdjęcie użytkownika.");
        }

        // =========================================
        // SPRAWDZENIE "TAK"
        // =========================================

        if (message && isApproval(message) && pendingPosts[senderId]) {
            const pending = pendingPosts[senderId];

            console.log("========================================");
            console.log("UŻYTKOWNIK ZATWIERDZIŁ PUBLIKACJĘ!");
            console.log("Treść posta:", pending.text);
            console.log("Zdjęcie:", pending.imageUrl || "(brak)");
            console.log(
                "Kategoria:",
                getCategory(pending.category).label
            );

            try {
                const result = await publishFacebookPost(
                    pending.text,
                    pending.imageUrl,
                    pending.category || "ogloszenia"
                );

                console.log("POST OPUBLIKOWANY:", result);
                delete pendingPosts[senderId];
                saveJSON(PENDING_POSTS_FILE, pendingPosts);
                delete userImages[senderId];
                saveJSON(USER_IMAGES_FILE, userImages);

                await sendFacebookMessage(
                    senderId,
                    `✅ Gotowe! Ogłoszenie zostało opublikowane na Spotted Brodnica.\n\n${getCategory(pending.category).label}`
                );
            } catch (publishError) {
                console.error("========================================");
                console.error("BŁĄD PUBLIKACJI:");
                console.error(publishError);
                console.error("========================================");

                await sendFacebookMessage(
                    senderId,
                    "⚠️ Ogłoszenie jest gotowe, ale wystąpił problem podczas publikacji. Nie opublikowałem go ponownie, żeby nie stworzyć duplikatu."
                );
            }

            res.sendStatus(200);
            return;
        }

        // =========================================
        // HISTORIA ROZMOWY
        // =========================================

        let history = conversations[senderId] || [];
        let userContent;

        if (imageUrl) {
            userContent = [
                {
                    type: "input_text",
                    text:
                        message ||
                        "Użytkownik wysłał zdjęcie. Przeanalizuj zdjęcie i wykorzystaj je w przygotowaniu ogłoszenia."
                },
                {
                    type: "input_image",
                    image_url: imageUrl
                }
            ];
        } else {
            userContent = message || "";
        }

        history.push({ role: "user", content: userContent });
        if (history.length > 30) history = history.slice(-30);

        const response = await openai.responses.create({
            model: "gpt-5.6",
            input: [
                {
                    role: "system",
                    content: `
Jesteś AI obsługującym profil Spotted Brodnica.

Twoim zadaniem jest prowadzenie rozmowy z mieszkańcami Brodnicy i okolic oraz przygotowywanie ogłoszeń do publikacji na stronie Spotted Brodnica.

Pamiętaj całą historię rozmowy.

Nie pytaj ponownie o informacje, które użytkownik już podał.

Nie wymyślaj informacji.

Odpowiadaj zawsze po polsku.

Pisz naturalnie, krótko i konkretnie.

========================================
KATEGORIE OGŁOSZEŃ
========================================

Każde gotowe ogłoszenie MUSI mieć dokładnie jedną kategorię.

Dostępne identyfikatory:

wypadek_zdarzenie = 🚨 WYPADEK / ZDARZENIE
zwierzeta = 🐾 ZAGINIONE / ZNALEZIONE ZWIERZĘ
droga = 🚧 UTRUDNIENIA NA DRODZE
osoba = 🔎 ZAGINĄŁ / ZNALEZIONO OSOBĘ
informacja = 📢 WAŻNA INFORMACJA
firma = 🏪 FIRMA / REKLAMA
ogloszenia = 📢 OGŁOSZENIA
zdjecie_film = 📸 ZDJĘCIE / FILM

========================================
ZASADY WYBORU KATEGORII
========================================

Jeżeli użytkownik zgłasza znalezione lub zaginione zwierzę:
→ zwierzeta

Jeżeli użytkownik zgłasza:
- wypadek
- kolizję
- pożar
- niebezpieczne zdarzenie
- inne nagłe zdarzenie

→ wypadek_zdarzenie

Jeżeli użytkownik zgłasza:
- korek
- remont drogi
- zamkniętą drogę
- objazd
- utrudnienia
- problemy z przejazdem

→ droga

Jeżeli użytkownik zgłasza:
- zaginięcie osoby
- poszukiwanie osoby
- znalezienie osoby

→ osoba

Jeżeli użytkownik przekazuje:
- ważny komunikat
- alert
- ostrzeżenie
- istotną informację lokalną

→ informacja

Jeżeli użytkownik reklamuje:
- firmę
- sklep
- usługę
- promocję
- działalność gospodarczą

→ firma

Jeżeli użytkownik:
- sprzedaje
- kupuje
- wynajmuje
- oddaje
- zamienia
- szuka produktu
- szuka usługi

→ ogloszenia

Jeżeli użytkownik przesyła przede wszystkim zdjęcie lub film lokalny i materiał nie pasuje do powyższych kategorii:
→ zdjecie_film

Nie wybieraj kategorii tylko na podstawie pojedynczego słowa.

Uwzględnij cały kontekst rozmowy.

========================================
ZWIERZĘTA
========================================

Jeżeli użytkownik zgłasza znalezione lub zaginione zwierzę, ustal:
- gatunek
- znalezione czy zaginione
- miejsce
- kiedy
- wygląd
- umaszczenie
- płeć, jeśli znana
- kontakt
- zdjęcie, jeśli dostępne

Jeżeli użytkownik wysłał zdjęcie, przeanalizuj je i wykorzystaj rzeczywiście widoczne informacje.

Nie wymyślaj rasy, wieku ani płci, jeśli nie można ich wiarygodnie określić.

========================================
INNE OGŁOSZENIA
========================================

Pomóż ustalić wszystkie informacje potrzebne do stworzenia dobrego ogłoszenia.

========================================
ZDJĘCIA
========================================

Jeżeli użytkownik wysłał zdjęcie, zapamiętaj, że zdjęcie jest już dostępne.

Nie pytaj ponownie o zdjęcie, jeżeli użytkownik już je wysłał.

========================================
GOTOWE OGŁOSZENIE
========================================

Kiedy masz wystarczającą ilość informacji, przygotuj gotowe ogłoszenie.

Ogłoszenie MUSI być zapisane dokładnie w takim formacie:

[KATEGORIA]

identyfikator_kategorii

[/KATEGORIA]

[OGLOSZENIE]

treść gotowego ogłoszenia

[/OGLOSZENIE]

Następnie napisz:

"Czy zatwierdzasz ogłoszenie do publikacji?"

Nie publikujesz samodzielnie.

Publikacja nastąpi dopiero po wyraźnym potwierdzeniu użytkownika, np. "tak", "zatwierdzam", "publikuj".

========================================
WAŻNE
========================================

Jeżeli użytkownik nie podał jeszcze wszystkich ważnych informacji, NIE twórz ogłoszenia.

Zadaj krótkie pytanie o brakującą informację.

Nie pytaj ponownie o informacje, które użytkownik już podał.

Jeżeli informacje są kompletne — przygotuj ogłoszenie.
`
                },
                ...history
            ]
        });

        const answer = response.output_text;
        console.log("Odpowiedź AI:", answer);

        const postText = extractPost(answer);
        if (postText) {
            console.log("Wykryto gotowe ogłoszenie.");
            const category = extractCategory(answer);
            console.log("Kategoria:", getCategory(category).label);

            const savedImage = userImages[senderId] || null;
            pendingPosts[senderId] = {
                text: postText,
                category: category,
                imageUrl: savedImage,
                createdAt: new Date().toISOString()
            };

            saveJSON(PENDING_POSTS_FILE, pendingPosts);
            console.log("Ogłoszenie oczekuje na zatwierdzenie.");
            console.log(
                "Zdjęcie przypisane do ogłoszenia:",
                savedImage || "(brak)"
            );
            console.log(
                "Kategoria przypisana do ogłoszenia:",
                getCategory(category).label
            );
        }

        history.push({ role: "assistant", content: answer });
        conversations[senderId] = history;
        saveJSON(CONVERSATIONS_FILE, conversations);

        await sendFacebookMessage(senderId, answer);
    } catch (error) {
        console.error("========================================");
        console.error("BŁĄD:");
        console.error(error);
        console.error("========================================");
    }

    res.sendStatus(200);
});

// =====================================================
// START SERWERA
// =====================================================

const PORT = 3000;

app.listen(PORT, () => {
    console.log(`Server działa na porcie ${PORT}`);
});

app.get("/privacy-policy", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polityka prywatności — Spotted Brodnica AI</title>
<style>
body {
    font-family: Arial, sans-serif;
    max-width: 900px;
    margin: 0 auto;
    padding: 40px 20px;
    line-height: 1.7;
    color: #222;
}
h1 { color: #111; }
h2 { margin-top: 30px; }
</style>
</head>
<body>

<h1>Polityka prywatności</h1>
<p><strong>Spotted Brodnica AI</strong></p>
<p>Ostatnia aktualizacja: 15 sierpnia 2026 r.</p>

<h2>1. Informacje ogólne</h2>
<p>
Spotted Brodnica AI umożliwia użytkownikom przesyłanie zgłoszeń
za pośrednictwem Facebook Messenger oraz przygotowywanie ogłoszeń
na potrzeby strony Spotted Brodnica.
</p>

<h2>2. Przetwarzane dane</h2>
<p>System może otrzymywać:</p>
<ul>
<li>treść wiadomości,</li>
<li>zdjęcia i materiały przesłane przez użytkownika,</li>
<li>identyfikator użytkownika Facebook/Messenger przekazywany przez Meta,</li>
<li>informacje niezbędne do obsługi zgłoszenia.</li>
</ul>

<h2>3. Cel przetwarzania</h2>
<p>
Dane są wykorzystywane do obsługi zgłoszeń, przygotowywania ogłoszeń,
kontaktu z użytkownikiem, publikowania zaakceptowanych ogłoszeń
oraz zapewnienia bezpieczeństwa systemu.
</p>

<h2>4. Sztuczna inteligencja</h2>
<p>
Spotted Brodnica AI wykorzystuje technologie sztucznej inteligencji
do analizy treści wiadomości i przygotowywania propozycji ogłoszeń.
Przed publikacją ogłoszenie może zostać przedstawione użytkownikowi
do akceptacji.
</p>

<h2>5. Facebook i Meta</h2>
<p>
System wykorzystuje Facebook Messenger oraz interfejsy programistyczne
Meta do odbierania i wysyłania wiadomości.
</p>

<h2>6. Udostępnianie danych</h2>
<p>
Dane nie są sprzedawane. Mogą być przetwarzane przez dostawców usług
technicznych niezbędnych do działania systemu.
</p>

<h2>7. Okres przechowywania</h2>
<p>
Dane są przechowywane przez okres niezbędny do obsługi zgłoszenia,
zapewnienia bezpieczeństwa systemu oraz realizacji obowiązków
wynikających z obowiązujących przepisów.
</p>

<h2>8. Prawa użytkownika</h2>
<p>
Użytkownik może, w zakresie przewidzianym prawem, żądać dostępu do
swoich danych, ich sprostowania, usunięcia lub ograniczenia przetwarzania.
</p>

<h2>9. Usunięcie danych</h2>
<p>
W celu usunięcia danych przekazanych do systemu Spotted Brodnica AI
użytkownik może skontaktować się ze Spotted Brodnica za pośrednictwem
kanału, przez który przesłał zgłoszenie.
</p>

<h2>10. Bezpieczeństwo</h2>
<p>
Podejmujemy odpowiednie środki techniczne i organizacyjne mające
na celu ochronę danych przed nieuprawnionym dostępem i wykorzystaniem.
</p>

<h2>11. Kontakt</h2>
<p>
W sprawach dotyczących prywatności można skontaktować się ze
Spotted Brodnica za pośrednictwem strony Spotted Brodnica.
</p>

</body>
</html>
    `);
});

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

        spamBans =
            JSON.parse(
                fs.readFileSync(
                    SPAM_BANS_FILE,
                    "utf8"
                ).replace(/^\uFEFF/, "")
            );

    }

} catch (error) {

    console.error(
        "BĹ‚Ä…d odczytu spam_bans.json:",
        error
    );

    spamBans = {};

}

function saveSpamBans() {

    fs.writeFileSync(
        SPAM_BANS_FILE,
        JSON.stringify(
            spamBans,
            null,
            2
        ),
        "utf8"
    );

}

// =====================================================
// ANTYSPAM / LIMITY UĹ»YTKOWNIKĂ“W
// =====================================================

const spamUsers = new Map();
const globalMessages = [];

const SPAM_CONFIG = {
    minInterval: 3000,          // 3 sekundy
    max10min: 25,               // 15 wiadomoĹ›ci / 10 min
    max1hour: 50,               // 50 / godz.
    max24hours: 80,            // 150 / 24 h

    duplicateWindow: 30000,     // 30 sekund
    duplicateLimit: 5,          // 5 identycznych

    burstWindow: 30000,         // 30 sekund
    burstLimit: 10,              // 10 wiadomoĹ›ci

    fiveMinuteWindow: 300000,   // 5 minut
    fiveMinuteLimit: 30,        // 30 wiadomoĹ›ci

    globalWarning: 500,         // ostrzeĹĽenie / godz.
    globalBlock: 1000           // blokada AI / godz.
};

function cleanupTimes(times, windowMs, now) {

    return times.filter(
        timestamp => now - timestamp <= windowMs
    );
    function registerSpamStrike(senderId, user, now) {

    user.strikes++;

    console.warn(
        `ANTYSPAM: ${senderId} - ` +
        `strike ${user.strikes}`
    );

    if (user.strikes >= 3) {

        spamBans[senderId] = {
            bannedUntil:
                now + 7 * 24 * 60 * 60000,

            strikes:
                user.strikes,

            reason:
                "spam"
        };

        saveSpamBans();

        console.warn(
            `ANTYSPAM: ${senderId} - ` +
            `BAN 7 DNI.`
        );

        return true;
    }

    return false;
}
}
function checkPermanentSpamBan(senderId) {

    const now = Date.now();

    const ban =
        spamBans[senderId];

    if (!ban) {

        return {
            banned: false
        };

    }

    if (
        ban.bannedUntil &&
        ban.bannedUntil > now
    ) {

        return {
            banned: true,
            remaining:
                Math.ceil(
                    (ban.bannedUntil - now) / 1000
                ),
            strikes:
                ban.strikes || 0
        };

    }

    delete spamBans[senderId];

    saveSpamBans();

    return {
        banned: false
    };

}

function checkSpam(senderId, message, imageUrl) {

    const now = Date.now();
        const existingUser = spamUsers.get(senderId);

    if (
        existingUser &&
        existingUser.lastAcceptedAt &&
        now - existingUser.lastAcceptedAt <
        SPAM_CONFIG.minInterval
    ) {

        console.warn(
            `ANTYSPAM: ${senderId} - ` +
            `wiadomoĹ›Ä‡ zbyt szybko. ` +
            `OdstÄ™p: ${now - existingUser.lastAcceptedAt} ms`
        );

        return {
            allowed: false,
            reason: "too_fast"
        };

    }

    let user =
        spamUsers.get(senderId);

    if (!user) {

        user = {
            times: [],
            blockedUntil: 0,
            lastMessageKey: "",
            duplicateTimes: [],
            strikes: 0,
            lastAcceptedAt: 0
        };

        spamUsers.set(
            senderId,
            user
        );

    }

    // -----------------------------------------
    // AKTUALNA BLOKADA
    // -----------------------------------------

    if (user.blockedUntil > now) {

        return {
            allowed: false,
            reason: "blocked",
            remaining:
                Math.ceil(
                    (user.blockedUntil - now) / 1000
                )
        };

    }

    // -----------------------------------------
    // PORZÄ„DKOWANIE HISTORII
    // -----------------------------------------

    user.times =
        cleanupTimes(
            user.times,
            86400000,
            now
        );

    user.duplicateTimes =
        cleanupTimes(
            user.duplicateTimes,
            SPAM_CONFIG.duplicateWindow,
            now
        );

    // -----------------------------------------
    // IDENTYCZNA WIADOMOĹšÄ†
    // -----------------------------------------

    const messageKey =
        JSON.stringify({
            message:
                (message || "")
                    .trim()
                    .toLowerCase(),
            image:
                imageUrl || ""
        });

    if (
        user.lastMessageKey === messageKey
    ) {

        user.duplicateTimes.push(now);

    } else {

        user.lastMessageKey =
            messageKey;

        user.duplicateTimes = [now];

    }

    if (
        user.duplicateTimes.length >=
        SPAM_CONFIG.duplicateLimit
    ) {

        registerSpamStrike(


            senderId,


            user,


            now


        );

        const blockMinutes =
            user.strikes >= 3
                ? 1440
                : user.strikes === 2
                    ? 120
                    : 30;

        user.blockedUntil =
            now +
            blockMinutes * 60000;

        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `identyczne wiadomoĹ›ci. ` +
            `Blokada ${blockMinutes} min.`
        );

        return {
            allowed: false,
            reason: "duplicate"
        };

    }

    // -----------------------------------------
    // MINIMALNY ODSTÄP 3 SEKUND
    // -----------------------------------------

    const lastMessage =
        user.times[
            user.times.length - 1
        ];

    if (
        lastMessage &&
        now - lastMessage <
        SPAM_CONFIG.minInterval
    ) {

        return {
            allowed: false,
            reason: "too_fast"
        };

    }

    // -----------------------------------------
    // LIMITY CZASOWE
    // -----------------------------------------

    const last10min =
        user.times.filter(
            t => now - t <= 600000
        );

    const lastHour =
        user.times.filter(
            t => now - t <= 3600000
        );

    if (
        last10min.length >=
        SPAM_CONFIG.max10min
    ) {

        registerSpamStrike(


            senderId,


            user,


            now


        );

        user.blockedUntil =
            now +
            (user.strikes >= 3
                ? 86400000
                : user.strikes === 2
                    ? 120 * 60000
                    : 30 * 60000);

        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `przekroczono 25/10 min.`
        );

        return {
            allowed: false,
            reason: "10min"
        };

    }

    if (
        lastHour.length >=
        SPAM_CONFIG.max1hour
    ) {

        registerSpamStrike(


            senderId,


            user,


            now


        );

        user.blockedUntil =
            now +
            (user.strikes >= 3
                ? 86400000
                : 3600000);

        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `przekroczono 50/h.`
        );

        return {
            allowed: false,
            reason: "hour"
        };

    }

    if (
        user.times.length >=
        SPAM_CONFIG.max24hours
    ) {

        registerSpamStrike(


            senderId,


            user,


            now


        );

        user.blockedUntil =
            now +
            86400000;

        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `przekroczono 150/24h.`
        );

        return {
            allowed: false,
            reason: "day"
        };

    }

    // -----------------------------------------
    // BURST 10 / 30 SEKUND
    // -----------------------------------------

    const burst =
        user.times.filter(
            t =>
                now - t <=
                SPAM_CONFIG.burstWindow
        );

    if (
        burst.length >=
        SPAM_CONFIG.burstLimit
    ) {

        registerSpamStrike(


            senderId,


            user,


            now


        );

        user.blockedUntil =
            now +
            10 * 60000;

        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `10 wiadomoĹ›ci / 30 sekund.`
        );

        return {
            allowed: false,
            reason: "burst"
        };

    }

    // -----------------------------------------
    // 30 / 5 MINUT
    // -----------------------------------------

    const fiveMinutes =
        user.times.filter(
            t =>
                now - t <=
                SPAM_CONFIG.fiveMinuteWindow
        );

    if (
        fiveMinutes.length >=
        SPAM_CONFIG.fiveMinuteLimit
    ) {

        registerSpamStrike(


            senderId,


            user,


            now


        );

        user.blockedUntil =
            now +
            60 * 60000;

        console.log(
            `ANTYSPAM: ${senderId} - ` +
            `30 wiadomoĹ›ci / 5 minut.`
        );

        return {
            allowed: false,
            reason: "5min"
        };

    }

    // -----------------------------------------
    // WIADOMOĹšÄ† PRZECHODZI
    // -----------------------------------------

    user.lastAcceptedAt = now;

user.times.push(now);

return {
    allowed: true
};

}


// =====================================================
// GLOBALNY BEZPIECZNIK AI
// =====================================================

function checkGlobalLimit() {

    const now =
        Date.now();

    while (
        globalMessages.length &&
        now - globalMessages[0] > 3600000
    ) {

        globalMessages.shift();

    }

    if (
        globalMessages.length >=
        SPAM_CONFIG.globalBlock
    ) {

        console.error(
            "!!! GLOBALNY LIMIT AI !!!"
        );

        return false;

    }

    globalMessages.push(now);

    if (
        globalMessages.length >=
        SPAM_CONFIG.globalWarning
    ) {

        console.warn(
            `UWAGA: ${globalMessages.length}` +
            ` wiadomoĹ›ci AI w ciÄ…gu godziny.`
        );

    }

    return true;

}
// =====================================================
// KATEGORIE SPOTTED
// =====================================================

const CATEGORIES = {
    wypadek_zdarzenie: {
        label: "đźš¨ WYPADEK / ZDARZENIE",
        hashtag: "#WypadekZdarzenie"
    },

    zwierzeta: {
        label: "đźľ ZAGINIONE / ZNALEZIONE ZWIERZÄ",
        hashtag: "#ZaginioneZwierzeta"
    },

    droga: {
        label: "đźš— UTRUDNIENIA NA DRODZE",
        hashtag: "#UtrudnieniaNaDrodze"
    },

    osoba: {
        label: "đź”Ť ZAGINÄ„Ĺ / ZNALEZIONO OSOBÄ",
        hashtag: "#ZaginionaOsoba"
    },

    informacja: {
        label: "đź“˘ WAĹ»NA INFORMACJA",
        hashtag: "#WaznaInformacja"
    },

    firma: {
        label: "đźŹŞ FIRMA / REKLAMA",
        hashtag: "#FirmaReklama"
    },

    ogloszenia: {
        label: "đźŹ  OGĹOSZENIA",
        hashtag: "#Ogloszenia"
    },

    zdjecie_film: {
        label: "đź“¸ ZDJÄCIE / FILM",
        hashtag: "#ZdjecieFilm"
    }
};


// =====================================================
// POBIERANIE KATEGORII
// =====================================================

function getCategory(category) {

    return (
        CATEGORIES[category] ||
        CATEGORIES.ogloszenia
    );

}


// =====================================================
// WYCIÄ„GANIE KATEGORII Z ODPOWIEDZI AI
// =====================================================

function extractCategory(text) {

    if (!text) {

        return "ogloszenia";

    }


    const match =
        text.match(
            /\[KATEGORIA\]\s*([^\s\]]+)\s*\[\/KATEGORIA\]/i
        );


    if (!match) {

        return "ogloszenia";

    }


    const value =
        match[1]
            .trim()
            .toLowerCase();


    if (CATEGORIES[value]) {

        return value;

    }


    return "ogloszenia";

}


// =====================================================
// PAMIÄÄ†
// =====================================================

function loadJSON(file) {

    try {

        if (fs.existsSync(file)) {

            return JSON.parse(
                fs.readFileSync(file, "utf8")
            );

        }

    } catch (error) {

        console.error(
            "BĹ‚Ä…d odczytu:",
            file,
            error
        );

    }

    return {};

}


function saveJSON(file, data) {

    try {

        fs.writeFileSync(
            file,
            JSON.stringify(data, null, 2),
            "utf8"
        );

    } catch (error) {

        console.error(
            "BĹ‚Ä…d zapisu:",
            file,
            error
        );

    }

}


let conversations =
    loadJSON(CONVERSATIONS_FILE);

let pendingPosts =
    loadJSON(PENDING_POSTS_FILE);

let userImages =
    loadJSON(USER_IMAGES_FILE);


// =====================================================
// FACEBOOK MESSENGER
// =====================================================

async function sendFacebookMessage(
    recipientId,
    text
) {

    const url =
        `https://graph.facebook.com/v23.0/${process.env.PAGE_ID}/messages`;


    const response =
        await fetch(url, {

            method: "POST",

            headers: {
                "Content-Type": "application/json; charset=utf-8"
            },

            body: JSON.stringify({

                recipient: {
                    id: recipientId
                },

                message: {
                    text: text
                },

                access_token:
                    process.env.PAGE_ACCESS_TOKEN

            })

        });


    const data =
        await response.json();


    console.log(
        "Facebook Messenger odpowiedziaĹ‚:",
        data
    );


    if (!response.ok) {

        throw new Error(
            JSON.stringify(data)
        );

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

    const pageId =
        process.env.PAGE_ID;

    const accessToken =
        process.env.PAGE_ACCESS_TOKEN;


    if (!pageId) {

        throw new Error(
            "Brak PAGE_ID w pliku .env"
        );

    }


    if (!accessToken) {

        throw new Error(
            "Brak PAGE_ACCESS_TOKEN w pliku .env"
        );

    }


    const categoryInfo =
        getCategory(category);


    // =================================================
    // TEKST PUBLIKOWANY NA FACEBOOKU
    // =================================================

    const facebookText =
        `${categoryInfo.label}\n\n${text}\n\n${categoryInfo.hashtag} #SpottedBrodnica`;


    // =================================================
    // POST ZE ZDJÄCIEM
    // =================================================

    if (imageUrl) {

        console.log(
            "========================================"
        );

        console.log(
            "Publikowanie posta ze zdjÄ™ciem..."
        );

        console.log(
            "Kategoria:",
            categoryInfo.label
        );

        console.log(
            "URL zdjÄ™cia:",
            imageUrl
        );


        // ---------------------------------------------
        // POBIERAMY ZDJÄCIE Z MESSENGERA
        // ---------------------------------------------

        let imageResponse;


        try {

            imageResponse =
                await fetch(imageUrl);

        } catch (error) {

            console.error(
                "BĹ‚Ä…d pobierania zdjÄ™cia:",
                error
            );

            throw new Error(
                "Nie udaĹ‚o siÄ™ pobraÄ‡ zdjÄ™cia z Messengera."
            );

        }


        // ---------------------------------------------
        // DRUGA PRĂ“BA Z TOKENEM
        // ---------------------------------------------

        if (!imageResponse.ok) {

            console.log(
                "Pierwsza prĂłba pobrania zdjÄ™cia nieudana.",
                "HTTP:",
                imageResponse.status
            );


            try {

                imageResponse =
                    await fetch(
                        imageUrl,
                        {
                            headers: {

                                Authorization:
                                    `Bearer ${accessToken}`

                            }
                        }
                    );

            } catch (error) {

                console.error(
                    "Druga prĂłba pobrania zdjÄ™cia nieudana:",
                    error
                );

            }

        }


        if (!imageResponse.ok) {

            throw new Error(
                `Nie udaĹ‚o siÄ™ pobraÄ‡ zdjÄ™cia z Messengera. HTTP ${imageResponse.status}`
            );

        }


        // ---------------------------------------------
        // POBIERAMY PLIK
        // ---------------------------------------------

        const imageBuffer =
            await imageResponse.arrayBuffer();


        const contentType =
            imageResponse.headers.get(
                "content-type"
            ) ||
            "image/jpeg";


        console.log(
            "Typ zdjÄ™cia:",
            contentType
        );


        console.log(
            "Rozmiar zdjÄ™cia:",
            imageBuffer.byteLength,
            "bajtĂłw"
        );


        // ---------------------------------------------
        // TWORZYMY BLOB
        // ---------------------------------------------

        const blob =
            new Blob(
                [
                    imageBuffer
                ],
                {
                    type: contentType
                }
            );


        // ---------------------------------------------
        // FORM DATA DLA FACEBOOK
        // ---------------------------------------------

        const formData =
            new FormData();


        formData.append(
            "source",
            blob,
            "spotted.jpg"
        );


        formData.append(
            "message",
            facebookText
        );


        formData.append(
            "access_token",
            accessToken
        );


        // ---------------------------------------------
        // FACEBOOK PHOTOS API
        // ---------------------------------------------

        const url =
            `https://graph.facebook.com/v23.0/${pageId}/photos`;


        console.log(
            "WysyĹ‚am zdjÄ™cie do Facebooka..."
        );


        const response =
            await fetch(
                url,
                {
                    method: "POST",
                    body: formData
                }
            );


        const data =
            await response.json();


        console.log(
            "Facebook odpowiedziaĹ‚:",
            data
        );


        if (!response.ok || data.error) {

            throw new Error(
                JSON.stringify(data)
            );

        }


        console.log(
            "========================================"
        );

        console.log(
            "POST ZE ZDJÄCIEM OPUBLIKOWANY!"
        );

        console.log(
            "ID:",
            data.id
        );

        console.log(
            "========================================"
        );


        return data;

    }


    // =================================================
    // POST BEZ ZDJÄCIA
    // =================================================

    console.log(
        "PublikujÄ™ post tekstowy..."
    );


    console.log(
        "Kategoria:",
        categoryInfo.label
    );


    const url =
        `https://graph.facebook.com/v23.0/${pageId}/feed`;


    const response =
        await fetch(
            url,
            {

                method: "POST",

                headers: {

                    "Content-Type":
                        "application/json; charset=utf-8"

                },

                body: JSON.stringify({

                    message:
                        facebookText,

                    access_token:
                        accessToken

                })

            }
        );


    const data =
        await response.json();


    console.log(
        "Facebook publikacja posta:",
        data
    );


    if (!response.ok || data.error) {

        throw new Error(
            JSON.stringify(data)
        );

    }


    console.log(
        "POST TEKSTOWY OPUBLIKOWANY!"
    );


    return data;

}


// =====================================================
// SPRAWDZENIE "TAK"
// =====================================================

function isApproval(text) {

    if (!text) {

        return false;

    }


    const value =
        text
            .trim()
            .toLowerCase()
            .replace(/[.!?,]/g, "")
            .replace(/\s+/g, " ");


    const approvals = [

        "tak",
        "yes",
        "zatwierdzam",
        "zatwierdzone",
        "publikuj",
        "opublikuj",
        "moĹĽesz publikowaÄ‡",
        "mozna publikowac",
        "moĹĽna publikowaÄ‡",
        "zgadzam siÄ™",
        "zgadzam sie",
        "ok",
        "okej",
        "okey",
        "dobrze",

        "tak zatwierdzam",
        "tak publikuj",
        "tak opublikuj",
        "tak moĹĽna",
        "tak mozna",
        "tak zgadzam siÄ™",
        "tak zgadzam sie"

    ];


    return approvals.includes(value);

}


// =====================================================
// WYCIÄ„GANIE OGĹOSZENIA
// =====================================================

function extractPost(text) {

    if (!text) {

        return null;

    }


    const match =
        text.match(
            /\[OGLOSZENIE\]([\s\S]*?)\[\/OGLOSZENIE\]/i
        );


    if (!match) {

        return null;

    }


    return match[1].trim();

}


// =====================================================
// STRONA GĹĂ“WNA
// =====================================================

app.get(
    "/",
    (req, res) => {

        res.send(
            "Spotted Brodnica AI dziaĹ‚a!"
        );

    }
);


// =====================================================
// FACEBOOK WEBHOOK - WERYFIKACJA
// =====================================================

app.get(
    "/webhook",
    (req, res) => {

        const VERIFY_TOKEN =
            "brodnica1234";


        const mode =
            req.query["hub.mode"];


        const token =
            req.query["hub.verify_token"];


        const challenge =
            req.query["hub.challenge"];


        if (
            mode === "subscribe" &&
            token === VERIFY_TOKEN
        ) {

            console.log(
                "Facebook zweryfikowaĹ‚ webhook!"
            );


            res
                .status(200)
                .send(challenge);

        } else {

            res.sendStatus(403);

        }

    }
);


// =====================================================
// FACEBOOK WEBHOOK - WIADOMOĹšCI
// =====================================================

app.post(
    "/webhook",
    async (req, res) => {

        console.log(
            "========================================"
        );


        console.log(
            "Otrzymano wiadomoĹ›Ä‡ z Facebooka:"
        );


        console.log(
            JSON.stringify(
                req.body,
                null,
                2
            )
        );


        try {

            const event =
                req.body?.entry?.[0]?.messaging?.[0];


            if (!event) {

                res.sendStatus(200);

                return;

            }


            // =========================================
            // WIADOMOĹšÄ† TEKSTOWA
            // =========================================

            const message =
                event?.message?.text;


            // =========================================
            // ZDJÄCIE
            // =========================================

            const imageUrl =
                event?.message?.attachments?.find(
                    attachment =>
                        attachment.type === "image"
                )?.payload?.url;


            // =========================================
            // ID UĹ»YTKOWNIKA
            // =========================================

            const senderId =
                event?.sender?.id;


            console.log(
                "ID uĹĽytkownika:",
                senderId
            );


            console.log(
                "TreĹ›Ä‡:",
                message || "(brak)"
            );


            console.log(
                "ZdjÄ™cie:",
                imageUrl || "(brak)"
            );


            if (!senderId) {

                res.sendStatus(200);

                return;

            }
// =========================================
// ANTYSPAM
// =========================================
// =========================================
// TRWAĹY BAN ANTYSPAM
// =========================================

const spamBan =
    checkPermanentSpamBan(senderId);

if (spamBan.banned) {

    console.warn(
        `ANTYSPAM: ${senderId} - ` +
        `AKTYWNY BAN. ` +
        `PozostaĹ‚o ${spamBan.remaining} sekund.`
    );

    res.sendStatus(200);

    return;

}
const spamCheck =
    checkSpam(
        senderId,
        message,
        imageUrl
    );

if (!spamCheck.allowed) {

    console.log(
        "ANTYSPAM - odrzucono wiadomoĹ›Ä‡:",
        senderId,
        spamCheck.reason
    );

    // Nie uruchamiamy AI.
    res.sendStatus(200);

    return;

}


// =========================================
// GLOBALNY LIMIT AI
// =========================================

if (!checkGlobalLimit()) {

    console.error(
        "GLOBALNY LIMIT - AI NIE ZOSTAĹO URUCHOMIONE."
    );

    res.sendStatus(200);

    return;

}

            // =========================================
            // ZAPISUJEMY OSTATNIE ZDJÄCIE
            // =========================================

            if (imageUrl) {

                userImages[senderId] =
                    imageUrl;


                saveJSON(
                    USER_IMAGES_FILE,
                    userImages
                );


                console.log(
                    "ZapamiÄ™tano zdjÄ™cie uĹĽytkownika."
                );

            }


            // =========================================
            // SPRAWDZENIE "TAK"
            // =========================================

            if (
                message &&
                isApproval(message) &&
                pendingPosts[senderId]
            ) {

                const pending =
                    pendingPosts[senderId];


                console.log(
                    "========================================"
                );


                console.log(
                    "UĹ»YTKOWNIK ZATWIERDZIĹ PUBLIKACJÄ!"
                );


                console.log(
                    "TreĹ›Ä‡ posta:",
                    pending.text
                );


                console.log(
                    "ZdjÄ™cie:",
                    pending.imageUrl || "(brak)"
                );


                console.log(
                    "Kategoria:",
                    getCategory(
                        pending.category
                    ).label
                );


                try {

                    const result =
                        await publishFacebookPost(

                            pending.text,

                            pending.imageUrl,

                            pending.category ||
                                "ogloszenia"

                        );


                    console.log(
                        "POST OPUBLIKOWANY:",
                        result
                    );


                    // ---------------------------------
                    // USUWAMY OCZEKUJÄ„CE OGĹOSZENIE
                    // ---------------------------------

                    delete pendingPosts[senderId];


                    saveJSON(
                        PENDING_POSTS_FILE,
                        pendingPosts
                    );


                    // ---------------------------------
                    // USUWAMY ZDJÄCIE
                    // ---------------------------------

                    delete userImages[senderId];


                    saveJSON(
                        USER_IMAGES_FILE,
                        userImages
                    );


                    await sendFacebookMessage(

                        senderId,

                        `âś… Gotowe! OgĹ‚oszenie zostaĹ‚o opublikowane na Spotted Brodnica.

${getCategory(pending.category).label}`

                    );


                } catch (publishError) {

                    console.error(
                        "========================================"
                    );


                    console.error(
                        "BĹÄ„D PUBLIKACJI:"
                    );


                    console.error(
                        publishError
                    );


                    console.error(
                        "========================================"
                    );


                    await sendFacebookMessage(

                        senderId,

                        "âš ď¸Ź OgĹ‚oszenie jest gotowe, ale wystÄ…piĹ‚ problem podczas publikacji. Nie opublikowaĹ‚em go ponownie, ĹĽeby nie stworzyÄ‡ duplikatu."

                    );

                }


                res.sendStatus(200);

                return;

            }


            // =========================================
            // HISTORIA ROZMOWY
            // =========================================

            let history =
                conversations[senderId] || [];


            // =========================================
            // TREĹšÄ† DLA OPENAI
            // =========================================

            let userContent;


            if (imageUrl) {

                userContent = [

                    {

                        type:
                            "input_text",

                        text:
                            message ||
                            "UĹĽytkownik wysĹ‚aĹ‚ zdjÄ™cie. Przeanalizuj zdjÄ™cie i wykorzystaj je w przygotowaniu ogĹ‚oszenia."

                    },

                    {

                        type:
                            "input_image",

                        image_url:
                            imageUrl

                    }

                ];

            } else {

                userContent =
                    message || "";

            }


            // =========================================
            // DODAJEMY WIADOMOĹšÄ† DO HISTORII
            // =========================================

            history.push({

                role:
                    "user",

                content:
                    userContent

            });


            // =========================================
            // MAKSYMALNIE 30 WIADOMOĹšCI
            // =========================================

            if (
                history.length > 30
            ) {

                history =
                    history.slice(-30);

            }


            // =========================================
            // OPENAI
            // =========================================

            const response =
                await openai.responses.create({

                    model:
                        "gpt-5.6",

                    input: [

                        {

                            role:
                                "system",

                            content: `

JesteĹ› AI obsĹ‚ugujÄ…cym profil Spotted Brodnica.

Twoim zadaniem jest prowadzenie rozmowy z mieszkaĹ„cami Brodnicy i okolic oraz przygotowywanie ogĹ‚oszeĹ„ do publikacji na stronie Spotted Brodnica.

PamiÄ™taj caĹ‚Ä… historiÄ™ rozmowy.

Nie pytaj ponownie o informacje, ktĂłre uĹĽytkownik juĹĽ podaĹ‚.

Nie wymyĹ›laj informacji.

Odpowiadaj zawsze po polsku.

Pisz naturalnie, krĂłtko i konkretnie.


========================================
KATEGORIE OGĹOSZEĹ
========================================

KaĹĽde gotowe ogĹ‚oszenie MUSI mieÄ‡ dokĹ‚adnie jednÄ… kategoriÄ™.

DostÄ™pne identyfikatory:

wypadek_zdarzenie = đźš¨ WYPADEK / ZDARZENIE

zwierzeta = đźľ ZAGINIONE / ZNALEZIONE ZWIERZÄ

droga = đźš— UTRUDNIENIA NA DRODZE

osoba = đź”Ť ZAGINÄ„Ĺ / ZNALEZIONO OSOBÄ

informacja = đź“˘ WAĹ»NA INFORMACJA

firma = đźŹŞ FIRMA / REKLAMA

ogloszenia = đźŹ  OGĹOSZENIA

zdjecie_film = đź“¸ ZDJÄCIE / FILM


========================================
ZASADY WYBORU KATEGORII
========================================

JeĹĽeli uĹĽytkownik zgĹ‚asza znalezione lub zaginione zwierzÄ™:

â†’ zwierzeta


JeĹĽeli uĹĽytkownik zgĹ‚asza:

- wypadek
- kolizjÄ™
- poĹĽar
- niebezpieczne zdarzenie
- inne nagĹ‚e zdarzenie

â†’ wypadek_zdarzenie


JeĹĽeli uĹĽytkownik zgĹ‚asza:

- korek
- remont drogi
- zamkniÄ™tÄ… drogÄ™
- objazd
- utrudnienia
- problemy z przejazdem

â†’ droga


JeĹĽeli uĹĽytkownik zgĹ‚asza:

- zaginiÄ™cie osoby
- poszukiwanie osoby
- znalezienie osoby

â†’ osoba


JeĹĽeli uĹĽytkownik przekazuje:

- waĹĽny komunikat
- alert
- ostrzeĹĽenie
- istotnÄ… informacjÄ™ lokalnÄ…

â†’ informacja


JeĹĽeli uĹĽytkownik reklamuje:

- firmÄ™
- sklep
- usĹ‚ugÄ™
- promocjÄ™
- dziaĹ‚alnoĹ›Ä‡ gospodarczÄ…

â†’ firma


JeĹĽeli uĹĽytkownik:

- sprzedaje
- kupuje
- wynajmuje
- oddaje
- zamienia
- szuka produktu
- szuka usĹ‚ugi

â†’ ogloszenia


JeĹĽeli uĹĽytkownik przesyĹ‚a przede wszystkim zdjÄ™cie lub film lokalny i materiaĹ‚ nie pasuje do powyĹĽszych kategorii:

â†’ zdjecie_film


Nie wybieraj kategorii tylko na podstawie pojedynczego sĹ‚owa.

UwzglÄ™dnij caĹ‚y kontekst rozmowy.


========================================
ZWIERZÄTA
========================================

JeĹĽeli uĹĽytkownik zgĹ‚asza znalezione lub zaginione zwierzÄ™, ustal:

- gatunek
- znalezione czy zaginione
- miejsce
- kiedy
- wyglÄ…d
- umaszczenie
- pĹ‚eÄ‡, jeĹ›li znana
- kontakt
- zdjÄ™cie, jeĹ›li dostÄ™pne

JeĹĽeli uĹĽytkownik wysĹ‚aĹ‚ zdjÄ™cie, przeanalizuj je i wykorzystaj rzeczywiĹ›cie widoczne informacje.

Nie wymyĹ›laj rasy, wieku ani pĹ‚ci, jeĹ›li nie moĹĽna ich wiarygodnie okreĹ›liÄ‡.


========================================
INNE OGĹOSZENIA
========================================

PomĂłĹĽ ustaliÄ‡ wszystkie informacje potrzebne do stworzenia dobrego ogĹ‚oszenia.


========================================
ZDJÄCIA
========================================

JeĹĽeli uĹĽytkownik wysĹ‚aĹ‚ zdjÄ™cie, zapamiÄ™taj, ĹĽe zdjÄ™cie jest juĹĽ dostÄ™pne.

Nie pytaj ponownie o zdjÄ™cie, jeĹĽeli uĹĽytkownik juĹĽ je wysĹ‚aĹ‚.


========================================
GOTOWE OGĹOSZENIE
========================================

Kiedy masz wystarczajÄ…cÄ… iloĹ›Ä‡ informacji, przygotuj gotowe ogĹ‚oszenie.

OgĹ‚oszenie MUSI byÄ‡ zapisane dokĹ‚adnie w takim formacie:

[KATEGORIA]

identyfikator_kategorii

[/KATEGORIA]

[OGLOSZENIE]

treĹ›Ä‡ gotowego ogĹ‚oszenia

[/OGLOSZENIE]

NastÄ™pnie napisz:

"Czy zatwierdzasz ogĹ‚oszenie do publikacji?"

Nie publikujesz samodzielnie.

Publikacja nastÄ…pi dopiero po wyraĹşnym potwierdzeniu uĹĽytkownika, np. "tak", "zatwierdzam", "publikuj".


========================================
WAĹ»NE
========================================

JeĹĽeli uĹĽytkownik nie podaĹ‚ jeszcze wszystkich waĹĽnych informacji, NIE twĂłrz ogĹ‚oszenia.

Zadaj krĂłtkie pytanie o brakujÄ…cÄ… informacjÄ™.

Nie pytaj ponownie o informacje, ktĂłre uĹĽytkownik juĹĽ podaĹ‚.

JeĹĽeli informacje sÄ… kompletne â€” przygotuj ogĹ‚oszenie.

`

                        },

                        ...history

                    ]

                });


            // =========================================
            // ODPOWIEDĹą AI
            // =========================================

            const answer =
                response.output_text;


            console.log(
                "OdpowiedĹş AI:",
                answer
            );


            // =========================================
            // CZY AI PRZYGOTOWAĹO OGĹOSZENIE?
            // =========================================

            const postText =
                extractPost(answer);


            if (postText) {

                console.log(
                    "Wykryto gotowe ogĹ‚oszenie."
                );


                // -------------------------------------
                // WYCIÄ„GAMY KATEGORIÄ
                // -------------------------------------

                const category =
                    extractCategory(answer);


                console.log(
                    "Kategoria:",
                    getCategory(category).label
                );


                // -------------------------------------
                // NAJNOWSZE ZDJÄCIE
                // -------------------------------------

                const savedImage =
                    userImages[senderId] ||
                    null;


                pendingPosts[senderId] = {

                    text:
                        postText,

                    category:
                        category,

                    imageUrl:
                        savedImage,

                    createdAt:
                        new Date().toISOString()

                };


                saveJSON(
                    PENDING_POSTS_FILE,
                    pendingPosts
                );


                console.log(
                    "OgĹ‚oszenie oczekuje na zatwierdzenie."
                );


                console.log(
                    "ZdjÄ™cie przypisane do ogĹ‚oszenia:",
                    savedImage || "(brak)"
                );


                console.log(
                    "Kategoria przypisana do ogĹ‚oszenia:",
                    getCategory(category).label
                );

            }


            // =========================================
            // ZAPIS ODPOWIEDZI AI
            // =========================================

            history.push({

                role:
                    "assistant",

                content:
                    answer

            });


            conversations[senderId] =
                history;


            saveJSON(
                CONVERSATIONS_FILE,
                conversations
            );


            // =========================================
            // ODPOWIEDĹą NA MESSENGERZE
            // =========================================

            await sendFacebookMessage(

                senderId,

                answer

            );


        } catch (error) {

            console.error(
                "========================================"
            );


            console.error(
                "BĹÄ„D:"
            );


            console.error(
                error
            );


            console.error(
                "========================================"
            );

        }


        res.sendStatus(200);

    }
);


// =====================================================
// START SERWERA
// =====================================================

const PORT = 3000;


app.listen(
    PORT,
    () => {

        console.log(
            `Server dziaĹ‚a na porcie ${PORT}`
        );

    }
);app.get("/privacy-policy", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polityka prywatnoďż˝ci ďż˝ Spotted Brodnica AI</title>
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

<h1>Polityka prywatnoďż˝ci</h1>
<p><strong>Spotted Brodnica AI</strong></p>
<p>Ostatnia aktualizacja: 15 sierpnia 2026 r.</p>

<h2>1. Informacje ogďż˝lne</h2>
<p>
Spotted Brodnica AI umoďż˝liwia uďż˝ytkownikom przesyďż˝anie zgďż˝oszeďż˝
za poďż˝rednictwem Facebook Messenger oraz przygotowywanie ogďż˝oszeďż˝
na potrzeby strony Spotted Brodnica.
</p>

<h2>2. Przetwarzane dane</h2>
<p>System moďż˝e otrzymywaďż˝:</p>
<ul>
<li>treďż˝ďż˝ wiadomoďż˝ci,</li>
<li>zdjďż˝cia i materiaďż˝y przesďż˝ane przez uďż˝ytkownika,</li>
<li>identyfikator uďż˝ytkownika Facebook/Messenger przekazywany przez Meta,</li>
<li>informacje niezbďż˝dne do obsďż˝ugi zgďż˝oszenia.</li>
</ul>

<h2>3. Cel przetwarzania</h2>
<p>
Dane sďż˝ wykorzystywane do obsďż˝ugi zgďż˝oszeďż˝, przygotowywania ogďż˝oszeďż˝,
kontaktu z uďż˝ytkownikiem, publikowania zaakceptowanych ogďż˝oszeďż˝
oraz zapewnienia bezpieczeďż˝stwa systemu.
</p>

<h2>4. Sztuczna inteligencja</h2>
<p>
Spotted Brodnica AI wykorzystuje technologie sztucznej inteligencji
do analizy treďż˝ci wiadomoďż˝ci i przygotowywania propozycji ogďż˝oszeďż˝.
Przed publikacjďż˝ ogďż˝oszenie moďż˝e zostaďż˝ przedstawione uďż˝ytkownikowi
do akceptacji.
</p>

<h2>5. Facebook i Meta</h2>
<p>
System wykorzystuje Facebook Messenger oraz interfejsy programistyczne
Meta do odbierania i wysyďż˝ania wiadomoďż˝ci.
</p>

<h2>6. Udostďż˝pnianie danych</h2>
<p>
Dane nie sďż˝ sprzedawane. Mogďż˝ byďż˝ przetwarzane przez dostawcďż˝w usďż˝ug
technicznych niezbďż˝dnych do dziaďż˝ania systemu.
</p>

<h2>7. Okres przechowywania</h2>
<p>
Dane sďż˝ przechowywane przez okres niezbďż˝dny do obsďż˝ugi zgďż˝oszenia,
zapewnienia bezpieczeďż˝stwa systemu oraz realizacji obowiďż˝zkďż˝w
wynikajďż˝cych z obowiďż˝zujďż˝cych przepisďż˝w.
</p>

<h2>8. Prawa uďż˝ytkownika</h2>
<p>
Uďż˝ytkownik moďż˝e, w zakresie przewidzianym prawem, ďż˝ďż˝daďż˝ dostďż˝pu do
swoich danych, ich sprostowania, usuniďż˝cia lub ograniczenia przetwarzania.
</p>

<h2>9. Usuniďż˝cie danych</h2>
<p>
W celu usuniďż˝cia danych przekazanych do systemu Spotted Brodnica AI
uďż˝ytkownik moďż˝e skontaktowaďż˝ siďż˝ ze Spotted Brodnica za poďż˝rednictwem
kanaďż˝u, przez ktďż˝ry przesďż˝aďż˝ zgďż˝oszenie.
</p>

<h2>10. Bezpieczeďż˝stwo</h2>
<p>
Podejmujemy odpowiednie ďż˝rodki techniczne i organizacyjne majďż˝ce
na celu ochronďż˝ danych przed nieuprawnionym dostďż˝pem i wykorzystaniem.
</p>

<h2>11. Kontakt</h2>
<p>
W sprawach dotyczďż˝cych prywatnoďż˝ci moďż˝na skontaktowaďż˝ siďż˝ ze
Spotted Brodnica za poďż˝rednictwem strony Spotted Brodnica.
</p>

</body>
</html>
    `);
});




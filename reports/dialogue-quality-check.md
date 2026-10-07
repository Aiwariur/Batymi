# Batymi dialogue quality check

Provider: configured OpenAI-compatible endpoint; model: deepseek/deepseek-v4.1-flash. No credentials included.
This check called the configured language-model API and ran the local conversation guard. It did not call CRM, GreenAPI, or WhatsApp.

## outbound greeting, owner qualification, terms, and phase-two facts

Final CRM status: qualified; contact type: owner.

### Turn 1

Owner: Добрый день
CRM status: delivered → delivered; contact type: potential_owner; stopped: false
Actions: []

Raw model output:
```json
{
  "reply": "Добрый день!\n\nЯ Андрей, агентство Batumi.key — подбираем арендаторов на длительный срок в Батуми.\n\nВы собственник этой квартиры?",
  "actions": [],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Добрый день!

Я Андрей, агентство Batumi.key — подбираем арендаторов на длительный срок в Батуми.

Вы собственник этой квартиры?
```

### Turn 2

Owner: Да, активно
CRM status: delivered → delivered; contact type: potential_owner; stopped: false
Actions: [{"type":"update_rental_terms","listingId":101,"data":{"availability_status":"available"}}]

Raw model output:
```json
{
  "reply": "Понял, квартира актуальна.\n\nУточните, пожалуйста: вы собственник этой квартиры?",
  "actions": [
    { "type": "update_rental_terms", "listingId": 101, "data": { "availability_status": "available" } }
  ],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Понял, квартира актуальна.

Уточните, пожалуйста: вы собственник этой квартиры?
```

### Turn 3

Owner: Да, я собственник
CRM status: delivered → delivered; contact type: owner; stopped: false
Actions: [{"type":"set_contact_type","contactType":"owner"}]

Raw model output:
```json
{
  "reply": "Спасибо!\n\nМожем предлагать вашу квартиру нашим клиентам. Готовы сотрудничать с агентством?",
  "actions": [
    { "type": "set_contact_type", "contactType": "owner" }
  ],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Спасибо!

Можем предлагать вашу квартиру нашим клиентам. Готовы сотрудничать с агентством?
```

### Turn 4

Owner: Да, готова сотрудничать с агентством
CRM status: delivered → agreed; contact type: owner; stopped: false
Actions: [{"type":"set_crm_status","status":"agreed","listingId":101}]

Raw model output:
```json
{
  "reply": "Отлично, договорились 🤝\n\nЧтобы подготовить объявление, уточните, пожалуйста:\n— какой вид из окон?\n— название ЖК (или это дом без ЖК)?\n— минимальный срок аренды?\n— депозит и предоплата — сколько?\n— комиссия агентства: какая и кто её платит?",
  "actions": [
    { "type": "set_contact_type", "contactType": "owner" },
    { "type": "set_crm_status", "status": "agreed", "listingId": 101 }
  ],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Отлично, договорились 🤝

Чтобы подготовить объявление, уточните, пожалуйста:
— какой вид из окон?
— название ЖК (или это дом без ЖК)?
— минимальный срок аренды?
— депозит и предоплата — сколько?
— комиссия агентства: какая и кто её платит?
```

### Turn 5

Owner: Цена 500 долларов в месяц, депозит 500 долларов, минимальный срок 12 месяцев
CRM status: agreed → agreed; contact type: owner; stopped: false
Actions: [{"type":"update_rental_terms","listingId":101,"data":{"price":500,"deposit_amount":500,"minimum_lease_months":12}},{"type":"update_deal_info","listingId":101,"data":{"agent_notes":"Собственник уточнил месячную цену: 500 USD (в объявлении было 900 USD)."}}]

Raw model output:
```json
{
  "reply": "Записал: 500 USD в месяц, депозит 500 USD, минимальный срок 12 месяцев.\n\nОсталось два пункта:\n— какой вид из окон?\n— название ЖК или это дом без ЖК?",
  "actions": [
    {
      "type": "update_rental_terms",
      "listingId": 101,
      "data": {
        "price": 500,
        "currency": "USD",
        "deposit_amount": 500,
        "minimum_lease_months": 12
      }
    },
    {
      "type": "update_deal_info",
      "listingId": 101,
      "data": {
        "agent_notes": "Собственник уточнил месячную цену: 500 USD (в объявлении было 900 USD)."
      }
    }
  ],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Записал: 500 USD в месяц, депозит 500 USD, минимальный срок 12 месяцев.

Осталось два пункта:
— какой вид из окон?
— название ЖК или это дом без ЖК?
```

### Turn 6

Owner: Вид на море, ЖК Orbi City
CRM status: agreed → qualified; contact type: owner; stopped: true
Actions: [{"type":"update_deal_info","listingId":101,"data":{"window_view":"море","complex_name":"Orbi City"}},{"type":"set_crm_status","status":"qualified","listingId":101}]

Raw model output:
```json
{
  "reply": "Зафиксировал: Batumi, Kobaladze 12, 2 комн., 58 м², этаж 12, 500 USD в месяц, депозит 500 USD, минимальный срок 12 месяцев, вид из окон: на море, ЖК: Orbi City.\n\nСпасибо! Готовим публикацию, при необходимости менеджер свяжется.",
  "actions": [
    {
      "type": "update_deal_info",
      "listingId": 101,
      "data": {
        "window_view": "Вид на море",
        "complex_name": "Orbi City"
      }
    },
    {
      "type": "set_crm_status",
      "status": "qualified",
      "listingId": 101
    }
  ],
  "stopConversation": true
}
```

Final reply after local guard:
```text
Зафиксировал: Batumi, Kobaladze 12, 2 комн., 58 м², этаж 12, 500 USD в месяц, депозит 500 USD, минимальный срок 12 месяцев, вид из окон: на море, ЖК: Orbi City.

Спасибо! Готовим публикацию, при необходимости менеджер свяжется.
```

## listing identification followed by realtor disclosure

Final CRM status: delivered; contact type: realtor.

### Turn 1

Owner: О какой квартире речь?
CRM status: delivered → delivered; contact type: potential_owner; stopped: false
Actions: []

Raw model output:
```json
{
  "reply": "О квартире на *Kobaladze 12* в Батуми — 2 комнаты, 58 м², 12 этаж, 900 USD в месяц.\n\nВот объявление: https://example.com/flat/101\n\nЭто ваша квартира?",
  "actions": [],
  "stopConversation": false
}
```

Final reply after local guard:
```text
О квартире на *Kobaladze 12* в Батуми — 2 комнаты, 58 м², 12 этаж, 900 USD в месяц.

Вот объявление: https://example.com/flat/101

Это ваша квартира?
```

### Turn 2

Owner: Да, я агент, квартира сдаётся на год
CRM status: delivered → delivered; contact type: realtor; stopped: true
Actions: [{"type":"set_contact_type","contactType":"realtor"}]

Raw model output:
```json
{
  "reply": "Спасибо за уточнение. Мы работаем только с собственниками. Хорошего дня!",
  "actions": [
    { "type": "set_contact_type", "contactType": "realtor" }
  ],
  "stopConversation": true
}
```

Final reply after local guard:
```text
Спасибо за уточнение. Мы работаем только с собственниками. Хорошего дня!
```

## owner asks an unrecorded commission question

Final CRM status: agreed; contact type: owner.

### Turn 1

Owner: А какую комиссию вы берёте?
CRM status: agreed → agreed; contact type: owner; stopped: false
Actions: []

Raw model output:
```json
{
  "reply": "Комиссию мы обсуждаем индивидуально — конкретные условия согласуются с менеджером.\n\nПодскажите, какую комиссию вы готовы рассматривать?",
  "actions": [],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Комиссию мы обсуждаем индивидуально — конкретные условия согласуются с менеджером.

Подскажите, какую комиссию вы готовы рассматривать?
```

## screenshot regression: Lana gives owner, price, and minimum term in short transliterated replies

Final CRM status: delivered; contact type: owner.

### Turn 1

Owner: Da ia sobstvenik, ia lana
CRM status: delivered → delivered; contact type: owner; stopped: false
Actions: [{"type":"set_contact_type","contactType":"owner"}]

Raw model output:
```json
{"reply": "Спасибо, Лана.\nМожем предлагать вашу квартиру нашим клиентам на длительный срок. Готовы сотрудничать с агентством?", "actions": [{"type": "set_contact_type", "contactType": "owner"}], "stopConversation": false}
```

Final reply after local guard:
```text
Спасибо, Лана.
Можем предлагать вашу квартиру нашим клиентам на длительный срок. Готовы сотрудничать с агентством?
```

### Turn 2

Owner: 800$
CRM status: delivered → delivered; contact type: owner; stopped: false
Actions: [{"type":"update_rental_terms","listingId":101,"data":{"price":800}}]

Raw model output:
```json
{
  "reply": "Записал: 800 USD в месяц.\nГотовы сотрудничать с агентством?",
  "actions": [
    { "type": "set_contact_type", "contactType": "owner" },
    { "type": "update_rental_terms", "listingId": 101, "data": { "price": 800, "currency": "USD" } }
  ],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Записал: 800 USD в месяц.
Готовы сотрудничать с агентством?
```

### Turn 3

Owner: Minimalni 6 mesiacev
CRM status: delivered → delivered; contact type: owner; stopped: false
Actions: [{"type":"update_rental_terms","listingId":101,"data":{"minimum_lease_months":6}}]

Raw model output:
```json
{
  "reply": "Записал: минимальный срок — *6 месяцев*.\nГотовы сотрудничать с агентством?",
  "actions": [
    { "type": "set_contact_type", "contactType": "owner" },
    { "type": "update_rental_terms", "listingId": 101, "data": { "minimum_lease_months": 6 } }
  ],
  "stopConversation": false
}
```

Final reply after local guard:
```text
Записал: минимальный срок — *6 месяцев*.
Готовы сотрудничать с агентством?
```

## owner asks about current clients before agreeing

Final CRM status: delivered; contact type: owner.

### Turn 1

Owner: А сколько у вас сейчас клиентов?
CRM status: delivered → delivered; contact type: owner; stopped: false
Actions: []

Raw model output:
```json
{"reply": "Точного числа клиентов у нас нет — мы подбираем квартиры под конкретные запросы клиентов и предлагаем подходящие варианты.\n\nГотовы сотрудничать с агентством по вашей квартире?", "actions": [{"type": "set_contact_type", "contactType": "owner"}], "stopConversation": false}
```

Final reply after local guard:
```text
Точного числа клиентов у нас нет — мы подбираем квартиры под конкретные запросы клиентов и предлагаем подходящие варианты.

Готовы сотрудничать с агентством по вашей квартире?
```

## Assertions

All dialogue assertions passed.

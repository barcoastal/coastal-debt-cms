// Ad Template Engine — HTML/CSS based ad editor
// Each template is a function that returns HTML given content + person image

window.AdTemplates = {

  // Template 1: Light Classic (Understanding Your MCA Debt Matters!)
  light_classic: {
    name: 'Light Classic',
    desc: 'Light background, person left, text right',
    preview: { bg: '#F2F4F9', hl1: 'Understanding Your', hl1c: '#000', hl2: 'MCA Debt', hl2c: '#3052FF', hl3: 'Matters!', hl3c: '#FF9000' },
    render: function(data, w, h) {
      return `<div style="width:${w}px;height:${h}px;background:${data.bgColor || '#F2F4F9'};position:relative;overflow:hidden;font-family:'Montserrat',sans-serif;">
        ${data.personUrl ? `<img src="${data.personUrl}" style="position:absolute;bottom:0;left:0;height:85%;width:auto;z-index:2;">` : ''}
        ${data.chevronUrl ? `<img src="${data.chevronUrl}" style="position:absolute;top:3%;left:3%;width:30%;z-index:1;opacity:0.9;">` : ''}
        ${data.logoUrl ? `<img src="${data.logoUrl}" style="position:absolute;top:4%;right:5%;width:20%;z-index:10;">` : ''}
        <div style="position:absolute;top:12%;right:5%;width:48%;z-index:5;">
          <div style="font-size:${Math.round(h*0.065)}px;font-weight:800;color:#000;line-height:1.1;" contenteditable="true">${data.headline1 || 'Understanding'}<br>${data.headline2 || 'Your '}<span style="color:#3052FF;font-weight:800;">${data.headlineAccent || 'MCA Debt'}</span></div>
          <div style="font-size:${Math.round(h*0.065)}px;font-weight:800;color:#FF9000;line-height:1.1;margin-top:2px;" contenteditable="true">${data.headlineEnd || 'Matters!'}</div>
          <div style="font-size:${Math.round(h*0.025)}px;color:#000;margin-top:${Math.round(h*0.03)}px;line-height:1.5;" contenteditable="true">You need a <b>solution</b> tailored to your business challenges.</div>
          <div style="font-size:${Math.round(h*0.022)}px;color:#333;margin-top:${Math.round(h*0.025)}px;line-height:1.5;" contenteditable="true">Explore your options with<br><b>a free consultation:</b></div>
          <div style="display:inline-block;background:#3052FF;color:#fff;font-size:${Math.round(h*0.028)}px;font-weight:700;padding:${Math.round(h*0.015)}px ${Math.round(h*0.04)}px;border-radius:100px;margin-top:${Math.round(h*0.02)}px;" contenteditable="true">CoastalDebt.com</div>
        </div>
        <div style="position:absolute;bottom:3%;left:50%;transform:translateX(-50%);display:flex;gap:${Math.round(w*0.04)}px;z-index:10;">
          ${data.badges ? data.badges.map(b => `<img src="${b}" style="height:${Math.round(h*0.06)}px;width:auto;">`).join('') : ''}
        </div>
      </div>`;
    }
  },

  // Template 2: Blue Bold (Eliminate your MCA Debt)
  blue_bold: {
    name: 'Blue Bold',
    desc: 'Blue background, person right, bold orange accent',
    preview: { bg: '#3052FF', hl1: 'Eliminate', hl1c: '#FF9000', hl2: 'your MCA Debt', hl2c: '#fff' },
    render: function(data, w, h) {
      return `<div style="width:${w}px;height:${h}px;background:${data.bgColor || '#3052FF'};position:relative;overflow:hidden;font-family:'Montserrat',sans-serif;">
        ${data.personUrl ? `<img src="${data.personUrl}" style="position:absolute;bottom:0;right:0;height:80%;width:auto;z-index:2;">` : ''}
        ${data.chevronUrl ? `<img src="${data.chevronUrl}" style="position:absolute;top:3%;right:5%;width:25%;z-index:1;opacity:0.3;">` : ''}
        <div style="position:absolute;top:8%;left:5%;width:55%;z-index:5;">
          <div style="font-size:${Math.round(h*0.08)}px;font-weight:900;color:#FF9000;line-height:1.05;" contenteditable="true">${data.headline1 || 'Eliminate'}</div>
          <div style="font-size:${Math.round(h*0.07)}px;font-weight:800;color:#fff;line-height:1.1;margin-top:4px;" contenteditable="true">${data.headline2 || 'your'}<br>${data.headlineAccent || 'MCA Debt'}<br>${data.headlineEnd || 'in 6-18 months'}</div>
          <div style="font-size:${Math.round(h*0.03)}px;color:#fff;margin-top:${Math.round(h*0.04)}px;line-height:1.5;" contenteditable="true">Join our <b>Debt Relief<br>Program</b> Today!</div>
        </div>
        ${data.logoUrl ? `<img src="${data.logoUrl}" style="position:absolute;bottom:12%;left:5%;width:25%;z-index:10;">` : ''}
        <div style="position:absolute;bottom:3%;left:5%;display:flex;gap:${Math.round(w*0.03)}px;z-index:10;">
          ${data.badges ? data.badges.map(b => `<img src="${b}" style="height:${Math.round(h*0.055)}px;width:auto;">`).join('') : ''}
        </div>
      </div>`;
    }
  },

  // Template 3: Caps Blue (STUCK IN A MERCHANT CASH ADVANCE TRAP?)
  caps_blue: {
    name: 'Caps Bold',
    desc: 'Light background, big blue caps text, product focus',
    preview: { bg: '#3052FF', hl1: 'STUCK IN A', hl1c: '#fff', hl2: 'MERCHANT CASH', hl2c: '#fff' },
    render: function(data, w, h) {
      return `<div style="width:${w}px;height:${h}px;background:${data.bgColor || '#3052FF'};position:relative;overflow:hidden;font-family:'Montserrat',sans-serif;">
        ${data.personUrl ? `<img src="${data.personUrl}" style="position:absolute;bottom:0;right:-5%;height:65%;width:auto;z-index:2;">` : ''}
        <div style="position:absolute;top:8%;left:5%;width:65%;z-index:5;">
          <div style="font-size:${Math.round(h*0.065)}px;font-weight:900;color:#fff;line-height:1.1;text-transform:uppercase;" contenteditable="true">${data.headline1 || 'Stuck in a'}<br>${data.headlineAccent || 'Merchant Cash'}<br>${data.headlineEnd || 'Advance Trap?'}</div>
        </div>
        ${data.logoUrl ? `<img src="${data.logoUrl}" style="position:absolute;bottom:5%;left:5%;width:22%;z-index:10;">` : ''}
        <div style="position:absolute;bottom:5%;right:5%;font-size:${Math.round(h*0.018)}px;color:#fff;font-weight:600;z-index:10;" contenteditable="true">www.coastaldebt.com</div>
      </div>`;
    }
  },

  // Template 4: Script Mix (DON'T CONSOLIDATE MCA DEBT Annihilate it!)
  script_mix: {
    name: 'Mixed Style',
    desc: 'Light background, blue + black + italic accent',
    preview: { bg: '#F2F4F9', hl1: "DON'T CONSOLIDATE", hl1c: '#3052FF', hl2: 'MCA DEBT', hl2c: '#000' },
    render: function(data, w, h) {
      return `<div style="width:${w}px;height:${h}px;background:${data.bgColor || '#F2F4F9'};position:relative;overflow:hidden;font-family:'Montserrat',sans-serif;">
        ${data.chevronUrl ? `<div style="position:absolute;top:0;right:0;width:40%;height:100%;overflow:hidden;z-index:1;"><img src="${data.chevronUrl}" style="width:100%;height:auto;opacity:0.8;"></div>` : ''}
        ${data.logoUrl ? `<img src="${data.logoUrl}" style="position:absolute;top:5%;left:5%;width:22%;z-index:10;">` : ''}
        <div style="position:absolute;top:22%;left:5%;width:70%;z-index:5;">
          <div style="font-size:${Math.round(h*0.055)}px;font-weight:800;color:#3052FF;line-height:1.15;text-transform:uppercase;" contenteditable="true">${data.headline1 || "DON'T CONSOLIDATE"}</div>
          <div style="font-size:${Math.round(h*0.07)}px;font-weight:900;color:#000;line-height:1.1;text-transform:uppercase;" contenteditable="true">${data.headlineAccent || 'MCA DEBT'}</div>
          <div style="font-size:${Math.round(h*0.065)}px;font-weight:400;font-style:italic;color:#000;line-height:1.1;font-family:'Playfair Display',serif;margin-top:4px;" contenteditable="true">${data.headlineEnd || 'Annihilate it!'}</div>
          <div style="font-size:${Math.round(h*0.02)}px;color:#000;font-weight:600;text-transform:uppercase;margin-top:${Math.round(h*0.06)}px;line-height:1.6;" contenteditable="true">See if you qualify in minutes.<br>Enroll by Friday!</div>
        </div>
      </div>`;
    }
  }
};

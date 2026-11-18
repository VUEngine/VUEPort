import * as React from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { PLANET_VB_URL, VUENGINE_URL, VUEPORT_URL } from './web-homebrew';

export default function WebAbout(): React.JSX.Element {
    return <div className='vp-about'>
        <a href={VUEPORT_URL} target="_blank">
            <img className="vp-about-logo" src="/vueport.webp" alt="VUEPort" />
        </a>
        <p className="vp-about-tagline">
            {nls.localize(
                'vueport/about/lead',
                'VUEPort (read "viewport") is a modern, accurate and easy-to-use Virtual Boy \
and VB Color emulator for your browser, desktop, mobile and VR device, built around the Shrooms-VB core.'
            )}
        </p>
        <p className="vp-about-tagline">
            {nls.localize(
                'vueport/about/madeBy',
                'Made by KR155E of Planet Virtual Boy and Team VUEngine'
            )}
            <br />
            {nls.localize(
                'vueport/about/withAiAssistance',
                'with AI assistance'
            )}.
        </p>
        <div className="vp-about-links">
            <a className="vp-about-site" href={VUEPORT_URL} target="_blank">
                {VUEPORT_URL.replace('https://', '').replace('www.', '')}
                <ArrowSquareOut size={13} />
            </a>
            <a className="vp-about-site" href={PLANET_VB_URL} target="_blank">
                {PLANET_VB_URL.replace('https://', '').replace('www.', '')}
                <ArrowSquareOut size={13} />
            </a>
            <a className="vp-about-site" href={VUENGINE_URL} target="_blank">
                {VUENGINE_URL.replace('https://', '').replace('www.', '')}
                <ArrowSquareOut size={13} />
            </a>
        </div>
        <div className="vp-about-versions">
            <span className="vp-about-badge">
                <span className="vp-about-badge-label">
                    {nls.localize('vueport/about/version', 'Version')}
                </span>
                <span className="vp-about-badge-value">{VUEPORT_VERSION}</span>
            </span>
            <span className="vp-about-badge">
                <span className="vp-about-badge-label">Shrooms VB</span>
                <span className="vp-about-badge-value">6e9b727b31 (Patched)</span>
            </span>
            <span className="vp-about-badge">
                <span className="vp-about-badge-label">rcheevos</span>
                <span className="vp-about-badge-value">v12.4.0</span>
            </span>
        </div>
    </div>;
}
